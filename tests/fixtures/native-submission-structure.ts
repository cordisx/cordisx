// Synthetic semantic shapes, not copies of a particular Desktop build.
export const primary = `
async function submit({clearStopTurnConfirmation:clear,submitTarget:target,isResponseInProgress:response,options:options={},followUp:follow,conversationId:thread,defaultFollowUpSubmitAction:action,editingQueuedMessagePosition:edit}) {
  let {skipGoalReplacementConfirmation:skip=false,skipGoalSubmit:skipSubmit=false,promptRawOverride:raw,persistedPromptRawOverride:persisted}=options;
  clear();let draft={input:options.input};let context={...draft,threadReferences:[],openingPromptForHistory:options.input};
  return context;
}
let select;select=(model,effort)=>{updateModel(model,effort)};
globalThis.menu={onSelectModel:select,onSelectReasoningEffort:()=>{},onSelectModelOption:()=>{}};
async function draft({context:context,prompt:prompt,workspaceRoots:roots,permissionSelection:permission,serviceTier:serviceTier}) {
  return {configOverrides:{safe:'retained'},requiresThreadReferences:false,input:prompt,serviceTier:serviceTier};
}
async function existing({context:context,targetConversationId:thread,restoreMessage:restore,clientUserMessageId:message,serviceTier:serviceTier}) {
  return {threadId:thread,turnTrigger:'composer',clientUserMessageId:message,input:context.input,multiAgentMode:null,serviceTier:serviceTier};
}
globalThis.submit=submit;globalThis.draft=draft;globalThis.existing=existing;
`

export const initial = `
function createInput(input) {
  let {configOverrides:overrides,input:prompt,threadStartKind:kind,requiresThreadReferences:references}=input;
  return {config:overrides,input:prompt,threadStartKind:kind,requiresThreadReferences:references};
}
async function normalize(manager,thread,operation) {
  let {inheritThreadSettings:inherit=true,usePermissionSelection:permission=false,useAppServerPermissionDefault:defaults}=operation.context??{};
  let request={input:operation.request.input,model:null,effort:null,multiAgentMode:null,serviceTier:null,cyberAccessProgram:undefined};
  let params={model:null,effort:null,multiAgentMode:null,serviceTier:null};return {request,params};
}
async function dispatch({manager:manager,operation:n,readPersistedValue:read,ownerWindowError:error}) {
  let prepared={request:n.request};
  {let n=manager.getConversation();let wire=normalizeWire(prepared.request,manager.requestClient.getAppServerVersion());
  return await manager.sendRequest('turn/start',wire);}
}
async function steer(manager,request) { return await manager.sendRequest('turn/steer',request); }
async function first(input) {
  let {projectAssignment:project,threadStartKind:kind,input:prompt,config:incoming,serviceTier:serviceTier,localTurnMetadata:metadata,attachments:attachments}=input;
  return {model:null,effort:null,multiAgentMode:null,input:prompt,toolOutput:null,collaborationMode:null,serviceTier:serviceTier};
}
globalThis.normalize=normalize;globalThis.dispatch=dispatch;globalThis.first=first;globalThis.steer=steer;
`
export const resources = () => [
  { url: 'app://-/assets/app-primary-unrecognized.js', source: primary },
  { url: 'app://-/assets/app-initial-unrecognized.js', source: initial },
]
