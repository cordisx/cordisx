export const taskInitialSource = `
async function create({scope:store,config:settings,sourceThreadId:source,model:model,thinking:effort,target:target,prompt:prompt,startWithoutFirstTurn:empty=false,onBeforeWorktreeCreate:before}) {
 if(settings!=null&&source!=null)throw Error('delegated config forbidden');
 if(target.type==='worktree')return worktree({scope:store,attachments:[],input:prompt,model:model,thinking:effort,startingState:target.startingState,projectPath:target.path,onBeforeWorktreeCreate:before,sourceThreadId:source});
 return local({scope:store,attachments:[],config:settings,input:prompt,model:model,thinking:effort,target:target,startWithoutFirstTurn:empty,sourceThreadId:source});
}
async function local({scope:store,config:settings,model:model,thinking:effort,target:target,sourceThreadId:source}) {
 const mode=collaboration(model,effort);
 return start({collaborationMode:mode,config:settings,projectAssignment:target.projectId,workspaceKind:target.type,threadSource:source});
}
async function worktree({scope:store,model:model,thinking:effort,projectPath:path,startingState:state,sourceThreadId:source}) {
 const params=await inputs({model:model,thinking:effort});
 return queue({startConversationParamsInput:params,startingState:state,launchMode:'start-conversation'});
}
async function first(store,manager,params,{readThreadCreationInputs:read,onFirstTurnReady:ready,onSettled:settled}) {
 return manager.executeTurnStart('created',{request:{threadId:'created',clientUserMessageId:'message',disabledPluginIds:[],collaborationMode:params.collaborationMode},context:{}});
}
export {create as nativeCreate};
globalThis.create=create;globalThis.local=local;globalThis.worktree=worktree;globalThis.first=first;
`
export const taskExecutionSource = `
import {nativeCreate as create} from "./initial.js";
async function dispatchCreate({scope:store,argumentsValue:args,sourceThreadId:source,parentTurnId:parent,rootTurnId:root}) {
 const parsed=parse(args);
 try {const args=parsed.target;return await create({scope:store,turnTrigger:'app_tool_create_thread',sourceThreadId:source,target:args,model:parsed.model,prompt:parsed.prompt,parentTurnId:parent,rootTurnId:root})}catch(error){throw error}
}
async function dispatch(message) {return dispatchCreate({scope:state,argumentsValue:message.arguments,sourceThreadId:'source',parentTurnId:'parent',rootTurnId:'root'})}
globalThis.dispatch=dispatch;
`
