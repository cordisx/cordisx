export const NATIVE_OPERATION_REQUEST_RESOURCE = Object.freeze({
  url: 'app://-/assets/app-initial-cadb12d4a15e.js',
  sha256: '73594359b28d81b6fcc9a52aac808f6a2e9fc32ced661adb3e23d297827b9285',
})

export const NATIVE_OPERATION_TOKEN_CONFIG_KEY = 'cordisx.operation_token'
const NEW_THREAD_ANCHOR = 't.elicitationPluginIds.map(e=>({type:`plugin`,id:e}))});let b=uMs'
const DECLARATION_ANCHOR =
  'j!=null&&c!=null&&!k&&(j.activePermissionProfile={id:c,extends:null},j.runtimeWorkspaceRoots=g);let M={request:{'
const REQUEST_ANCHOR =
  'threadId:a,turnTrigger:t,clientUserMessageId:m??p?.id,input:w,cwd:o,model:null,effort:null,multiAgentMode:GIn,serviceTier:l,'
const RETURN_ANCHOR = 'config:v,configOverrides:y,memoryPreferences:p,requiresThreadReferences:'
const CREATE_DECLARATION_ANCHOR = 'config:a,configOverrides:o,input:s,toolOutput:c,'
const CREATE_RETURN_ANCHOR = 'threadStartKind:S,config:o,...C===`projectless`?'
const START_DECLARATION_ANCHOR =
  'serviceName:L,config:R,projectAssignment:z,mode:ee,threadSource:B,threadStartKind:V,requiresThreadReferences:H=!1}=e,'
const FIRST_TURN_ANCHOR =
  'model:v==null?ae.model:null,serviceTier:ce,effort:v?.settings.reasoning_effort,multiAgentMode:y,input:a,toolOutput:u,collaborationMode:G'
const FINAL_TURN_DECLARATION_ANCHOR =
  'readPersistedValue:d},f){let p=n.request,{localTurnMetadata:m,attachments:h,commentAttachments:g,'
const FINAL_TURN_DISPATCH_ANCHOR =
  'let n=C.markRequestDispatched?.(),r=cRt(E.request,e.requestClient.getAppServerVersion());j=await e.sendRequest(`turn/start`,r,'
const MARKER = '__cordisxNativeOperationRequestTransformBuild8109V4'
const VERSION = 'app-initial-cadb12d4a15e:normalized-two-stage-operation-request-v4'

function token(context: string): string {
  const value = `${context}.__cordisxOperationToken`
  return `typeof ${value}===\`string\`&&${value}.length>=16&&${value}.length<=256&&!/[\\0\\r\\n]/u.test(${value})?${value}:void 0`
}

function tokenValue(value: string): string {
  return `typeof ${value}===\`string\`&&${value}.length>=16&&${value}.length<=256&&!/[\\0\\r\\n]/u.test(${value})?${value}:void 0`
}

function configToken(context: string): string {
  const value = `${context}.config?.[${JSON.stringify(NATIVE_OPERATION_TOKEN_CONFIG_KEY)}]`
  return `typeof ${value}===\`string\`&&${value}.length>=16&&${value}.length<=256&&!/[\\0\\r\\n]/u.test(${value})?${value}:void 0`
}

const NEW_THREAD_REPLACEMENT = `t.elicitationPluginIds.map(e=>({type:\`plugin\`,id:e}))});let __cxOperationToken=${
  token('t')
};__cxOperationToken!==void 0&&(y={...y,${
  JSON.stringify(NATIVE_OPERATION_TOKEN_CONFIG_KEY)
}:__cxOperationToken});let b=uMs`
const DECLARATION_REPLACEMENT =
  `j!=null&&c!=null&&!k&&(j.activePermissionProfile={id:c,extends:null},j.runtimeWorkspaceRoots=g);let __cxOperationToken=${
    token('i')
  };let M={request:{`
const REQUEST_REPLACEMENT = `${
  REQUEST_ANCHOR.replace(
    'serviceTier:l',
    'serviceTier:globalThis.__cordisxNativeServiceTierOverride===`priority`?`priority`:globalThis.__cordisxNativeServiceTierOverride===`default`?null:l',
  )
}...(__cxOperationToken===void 0?{}:{config:{${
  JSON.stringify(NATIVE_OPERATION_TOKEN_CONFIG_KEY)
}:__cxOperationToken}}),`
const CARRIER = '...(__cxOperationToken===void 0?{}:{__cordisxOperationToken:__cxOperationToken}),'
const RETURN_REPLACEMENT = `config:v,configOverrides:y,${CARRIER}memoryPreferences:p,requiresThreadReferences:`
const CREATE_DECLARATION_REPLACEMENT =
  'config:a,configOverrides:o,__cordisxOperationToken:__cxOperationToken,input:s,toolOutput:c,'
const CREATE_RETURN_REPLACEMENT = `threadStartKind:S,config:o,${CARRIER}...C===\`projectless\`?`
const START_DECLARATION_REPLACEMENT =
  'serviceName:L,config:R,__cordisxOperationToken:__cxOperationToken,projectAssignment:z,mode:ee,threadSource:B,threadStartKind:V,requiresThreadReferences:H=!1}=e,'
const FIRST_TURN_REPLACEMENT = `${
  FIRST_TURN_ANCHOR.replace(
    'serviceTier:ce',
    'serviceTier:globalThis.__cordisxNativeServiceTierOverride===`priority`?`priority`:globalThis.__cordisxNativeServiceTierOverride===`default`?null:ce',
  )
},...(__cxOperationToken===void 0?{}:{config:{${
  JSON.stringify(NATIVE_OPERATION_TOKEN_CONFIG_KEY)
}:__cxOperationToken}})`
const FINAL_TURN_DECLARATION_REPLACEMENT = `readPersistedValue:d},f){let p=n.request,__cxOperationToken=${
  configToken('p')
},{localTurnMetadata:m,attachments:h,commentAttachments:g,`
const FINAL_TURN_DISPATCH_REPLACEMENT =
  `let n=C.markRequestDispatched?.(),r=cRt(E.request,e.requestClient.getAppServerVersion());__cxOperationToken!==void 0&&(r={...r,config:{...r.config,${
    JSON.stringify(NATIVE_OPERATION_TOKEN_CONFIG_KEY)
  }:__cxOperationToken}});j=await e.sendRequest(\`turn/start\`,r,`

export const NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT = `globalThis.${MARKER}===${JSON.stringify(VERSION)}`
export const NATIVE_OPERATION_REQUEST_FENCE = `(delete globalThis.${MARKER},true)`

export function transformNativeOperationRequest(source: string) {
  for (
    const [name, anchor] of [
      ['new-thread context', NEW_THREAD_ANCHOR],
      ['existing-thread declaration', DECLARATION_ANCHOR],
      ['existing-thread request', REQUEST_ANCHOR],
      ['new-thread return', RETURN_ANCHOR],
      ['create-input declaration', CREATE_DECLARATION_ANCHOR],
      ['create-input return', CREATE_RETURN_ANCHOR],
      ['start-conversation declaration', START_DECLARATION_ANCHOR],
      ['first-turn request', FIRST_TURN_ANCHOR],
      ['final turn declaration', FINAL_TURN_DECLARATION_ANCHOR],
      ['final turn dispatch', FINAL_TURN_DISPATCH_ANCHOR],
    ]
  ) {
    const count = source.split(anchor!).length - 1
    if (count !== 1) throw new Error(`Expected one ${name} anchor, found ${count}`)
  }
  return {
    source: source.replace(NEW_THREAD_ANCHOR, NEW_THREAD_REPLACEMENT)
      .replace(DECLARATION_ANCHOR, DECLARATION_REPLACEMENT).replace(REQUEST_ANCHOR, REQUEST_REPLACEMENT)
      .replace(RETURN_ANCHOR, RETURN_REPLACEMENT)
      .replace(CREATE_DECLARATION_ANCHOR, CREATE_DECLARATION_REPLACEMENT)
      .replace(CREATE_RETURN_ANCHOR, CREATE_RETURN_REPLACEMENT)
      .replace(START_DECLARATION_ANCHOR, START_DECLARATION_REPLACEMENT)
      .replace(FIRST_TURN_ANCHOR, FIRST_TURN_REPLACEMENT)
      .replace(FINAL_TURN_DECLARATION_ANCHOR, FINAL_TURN_DECLARATION_REPLACEMENT)
      .replace(FINAL_TURN_DISPATCH_ANCHOR, FINAL_TURN_DISPATCH_REPLACEMENT)
      + `\n;globalThis.${MARKER}=${JSON.stringify(VERSION)};`,
    anchorMatches: 1,
    acknowledgementExpression: NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT,
    fenceExpression: NATIVE_OPERATION_REQUEST_FENCE,
  }
}

export const NATIVE_OPERATION_REQUEST_TRANSFORM = Object.freeze({
  ...NATIVE_OPERATION_REQUEST_RESOURCE,
  transform: transformNativeOperationRequest,
  requiredForDocumentReady: false,
})

export const NATIVE_OPERATION_REQUEST_RESOURCE_9275 = Object.freeze({
  url: 'app://-/assets/app-initial-4d7ea7f81c2d.js',
  sha256: '5dcf4a29db25b086f9bd11d053eec60cf0c50bfd988494969cec452e03f19245',
})

const NEW_THREAD_DECLARATION_ANCHOR_9275 =
  'additionalDeveloperInstructions:j,requiresThreadReferences:M}=e;if(D===`projectless`'
const NEW_THREAD_REQUEST_ANCHOR_9275 = 'collaborationMode:h,multiAgentMode:Y_n,serviceTier:g,daybreakEnabled:_,'
const NEW_THREAD_CONFIG_ANCHOR_9275 = 'threadSource:T,threadStartKind:E,config:c,...D===`projectless`?'
const EXISTING_THREAD_DECLARATION_ANCHOR_9275 =
  'async function lQt(e,t,n,r,i,a,o){let s=n.request,{inheritThreadSettings:c=!0,useAppServerPermissionDefault:l,usePermissionSelection:u=!1}=n.context??{},'
const EXISTING_THREAD_REQUEST_ANCHOR_9275 =
  'model:P,cyberAccessProgram:s.cyberAccessProgram,serviceTier:Te,effort:F,multiAgentMode:gQt,'
const EXISTING_THREAD_PARAMS_ANCHOR_9275 = 'model:P??null,serviceTier:Te,effort:F??null,multiAgentMode:gQt,'
const FINAL_TURN_DECLARATION_ANCHOR_9275 =
  'function T$t({manager:e,conversationId:t,operation:n,capabilities:r,origin:i,clientUserMessageId:a,createId:o,ownerWindowError:s,onOutcomeUnknown:c,onMessageAdded:l,onInitialTitleRequested:u,readPersistedValue:d},f){let p=n.request,{'
const FINAL_TURN_DISPATCH_ANCHOR_9275 =
  'let n=C.markRequestDispatched?.(),r=Ite(E.request,e.requestClient.getAppServerVersion());M=e.getConversation(t)?.environmentSelectionEvidence;'
const MARKER_9275 = '__cordisxNativeOperationRequestTransformBuild9275V1'
const VERSION_9275 = 'app-initial-4d7ea7f81c2d:normalized-operation-request-v1'
const SERVICE_TIER_OVERRIDE_9275 =
  'globalThis.__cordisxNativeServiceTierOverride===`priority`?`priority`:globalThis.__cordisxNativeServiceTierOverride===`default`?null:'

const NEW_THREAD_DECLARATION_REPLACEMENT_9275 =
  `additionalDeveloperInstructions:j,requiresThreadReferences:M,__cordisxOperationToken:__cxRawOperationToken}=e;let __cxOperationToken=${
    tokenValue('__cxRawOperationToken')
  };if(D===\`projectless\``
const NEW_THREAD_REQUEST_REPLACEMENT_9275 = NEW_THREAD_REQUEST_ANCHOR_9275.replace(
  'serviceTier:g',
  `serviceTier:${SERVICE_TIER_OVERRIDE_9275}g`,
)
const NEW_THREAD_CONFIG_REPLACEMENT_9275 =
  `threadSource:T,threadStartKind:E,config:__cxOperationToken===void 0?c:{...c,${
    JSON.stringify(NATIVE_OPERATION_TOKEN_CONFIG_KEY)
  }:__cxOperationToken},...D===\`projectless\`?`
const EXISTING_THREAD_DECLARATION_REPLACEMENT_9275 =
  `async function lQt(e,t,n,r,i,a,o){let __cxOperationContext=n.context??{},s=n.request,{inheritThreadSettings:c=!0,useAppServerPermissionDefault:l,usePermissionSelection:u=!1}=__cxOperationContext,__cxOperationToken=${
    token('__cxOperationContext')
  },`
const EXISTING_THREAD_REQUEST_REPLACEMENT_9275 = `${
  EXISTING_THREAD_REQUEST_ANCHOR_9275.replace(
    'serviceTier:Te',
    `serviceTier:${SERVICE_TIER_OVERRIDE_9275}Te`,
  )
}...(__cxOperationToken===void 0?{}:{config:{${
  JSON.stringify(NATIVE_OPERATION_TOKEN_CONFIG_KEY)
}:__cxOperationToken}}),`
const EXISTING_THREAD_PARAMS_REPLACEMENT_9275 = EXISTING_THREAD_PARAMS_ANCHOR_9275.replace(
  'serviceTier:Te',
  `serviceTier:${SERVICE_TIER_OVERRIDE_9275}Te`,
)
const FINAL_TURN_DECLARATION_REPLACEMENT_9275 =
  `function T$t({manager:e,conversationId:t,operation:n,capabilities:r,origin:i,clientUserMessageId:a,createId:o,ownerWindowError:s,onOutcomeUnknown:c,onMessageAdded:l,onInitialTitleRequested:u,readPersistedValue:d},f){let p=n.request,__cxOperationToken=${
    configToken('p')
  },{`
const FINAL_TURN_DISPATCH_REPLACEMENT_9275 =
  `let n=C.markRequestDispatched?.(),r=Ite(E.request,e.requestClient.getAppServerVersion());__cxOperationToken!==void 0&&(r={...r,config:{...r.config,${
    JSON.stringify(NATIVE_OPERATION_TOKEN_CONFIG_KEY)
  }:__cxOperationToken}});M=e.getConversation(t)?.environmentSelectionEvidence;`

export const NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT_9275 = `globalThis.${MARKER_9275}===${
  JSON.stringify(VERSION_9275)
}`
export const NATIVE_OPERATION_REQUEST_FENCE_9275 = `(delete globalThis.${MARKER_9275},true)`

/** Exact-pinned build-9275 transform; source mismatch fails closed. */
export function transformNativeOperationRequest9275(source: string) {
  for (
    const [name, anchor] of [
      ['new-thread declaration', NEW_THREAD_DECLARATION_ANCHOR_9275],
      ['new-thread request', NEW_THREAD_REQUEST_ANCHOR_9275],
      ['new-thread config', NEW_THREAD_CONFIG_ANCHOR_9275],
      ['existing-thread declaration', EXISTING_THREAD_DECLARATION_ANCHOR_9275],
      ['existing-thread request', EXISTING_THREAD_REQUEST_ANCHOR_9275],
      ['existing-thread params', EXISTING_THREAD_PARAMS_ANCHOR_9275],
      ['final turn declaration', FINAL_TURN_DECLARATION_ANCHOR_9275],
      ['final turn dispatch', FINAL_TURN_DISPATCH_ANCHOR_9275],
    ]
  ) {
    const count = source.split(anchor!).length - 1
    if (count !== 1) throw new Error(`Expected one build-9275 ${name} anchor, found ${count}`)
  }
  return {
    source: source.replace(NEW_THREAD_DECLARATION_ANCHOR_9275, NEW_THREAD_DECLARATION_REPLACEMENT_9275)
      .replace(NEW_THREAD_REQUEST_ANCHOR_9275, NEW_THREAD_REQUEST_REPLACEMENT_9275)
      .replace(NEW_THREAD_CONFIG_ANCHOR_9275, NEW_THREAD_CONFIG_REPLACEMENT_9275)
      .replace(EXISTING_THREAD_DECLARATION_ANCHOR_9275, EXISTING_THREAD_DECLARATION_REPLACEMENT_9275)
      .replace(EXISTING_THREAD_REQUEST_ANCHOR_9275, EXISTING_THREAD_REQUEST_REPLACEMENT_9275)
      .replace(EXISTING_THREAD_PARAMS_ANCHOR_9275, EXISTING_THREAD_PARAMS_REPLACEMENT_9275)
      .replace(FINAL_TURN_DECLARATION_ANCHOR_9275, FINAL_TURN_DECLARATION_REPLACEMENT_9275)
      .replace(FINAL_TURN_DISPATCH_ANCHOR_9275, FINAL_TURN_DISPATCH_REPLACEMENT_9275)
      + `\n;globalThis.${MARKER_9275}=${JSON.stringify(VERSION_9275)};`,
    anchorMatches: 1,
    acknowledgementExpression: NATIVE_OPERATION_REQUEST_ACKNOWLEDGEMENT_9275,
    fenceExpression: NATIVE_OPERATION_REQUEST_FENCE_9275,
  }
}

export const NATIVE_OPERATION_REQUEST_TRANSFORM_9275 = Object.freeze({
  ...NATIVE_OPERATION_REQUEST_RESOURCE_9275,
  transform: transformNativeOperationRequest9275,
  requiredForDocumentReady: false,
})
