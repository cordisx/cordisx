const HELP: Readonly<Record<string, string>> = {
  connections: 'List configured live Channel connections. Input: {}.',
  conversations: 'List conversations with readable names. Input: {account:{adapterId,accountId,tenantId}}.',
  bind:
    'Bind a chat to a conversation. Input: {sessionId,channel:{adapterId,accountId,tenantId,conversationId,kind,threadId,semantics},mode:"listen"|"deliver",autoReply?:false}. Bindings have no cardinality cap.',
  unbind: 'Remove bindings without deleting chats. Input: {sessionId,bindingId?:string,channel?:object}.',
  'bind-status': 'Read bindings and jobs for a chat. Input: {sessionId}.',
  'local-bindings':
    'Local CLI only: list profile bindings, optionally filtered. Input: {account?:{adapterId,accountId,tenantId},conversationId?:string}.',
  'continuation-policy': 'Local user only: read continuation policy and checkpoint state. Input: {sessionId}.',
  'continuation-policy-set':
    'Local user only: configure best-effort idle-boundary continuation. Input: {sessionId,policy:{enabled:boolean,threshold:number,reserveTokens:integer,maxAgeMs:integer}}. Disabled by default; no guarantee against compaction.',
  'continuation-start':
    'Local user only: start a fresh Channel task using its explicit checkpoint. Input: {sessionId}. An uncertain result must be inspected, never blindly repeated.',
  'continuation-checkpoint': 'Active Channel turn with --context only: read this task checkpoint. Input: {}.',
  'continuation-checkpoint-set':
    'Active Channel turn with --context only: save an explicit handoff. Input: {expectedRevision,checkpoint:{goal,constraints,completed,remaining,history,continueAtIdle:boolean}}. Use the revision returned by continuation-checkpoint; it is 0 when no checkpoint exists. Text is bounded; source session is assigned by the Host.',
  'continuation-history':
    'Active Channel continuation turn with --context only: read one bounded page from its confirmed source. Input: {limit?:1..32,cursor?:string}. No arbitrary source session is accepted.',
  history:
    'Retrieve accepted messages from all the chat bindings. Input: {sessionId,afterSequence?:number,limit?:number}.',
  'remote-history':
    'Read one remote Feishu/Lark page. Input: {account,conversationId,kind:"direct"|"group",startTime,endTime,pageSize?:1..50,pageToken?:string,order?:"asc"|"desc"}. Times are Unix seconds as decimal strings or integers; use hasMore/pageToken for continuation. Requires message read scope.',
  listen:
    'Wait for messages in multiple conversations. Input: {account,conversationIds:[string],afterCursor?:string,timeoutSeconds?:0..60}.',
  send:
    'Send explicitly. Input: {account,target:{id,kind,replyMode:"conversation"|"reply"|"thread",replyTo?:messageId},text,operationId}. Quote JSON safely. Only receipt.state=sent proves delivery.',
  'send-many':
    'Send explicitly to multiple destinations. Input: {account,targets:[target],text,operationId}. Validate the whole batch first; receipts report each target.',
  ask:
    'Ask with options or free text. Input: {account,target:{id,kind,replyMode?,replyTo?},question,options:[{label,value}],targetUserId?:string,operationId,expiresInSeconds?:number}. Feishu/Lark use a card with buttons and a text form; unsupported adapters receive numbered text. targetUserId limits card clicks, not visibility or free-text replies; non-card adapters reject it. After sending, wait for a later Channel user message. Only receipt.state=sent proves delivery.',
  'question-cancel':
    'Revoke a question card. Input: {account,operationId}. This prevents later button answers; it does not recall the sent message.',
  receipt:
    'Read an earlier send or question without resending. Input: {account,operationId,targetCount?:number}. Returns deliveryState and explicit receipt:null for not-found; not-found alone never proves a disconnected request was not sent.',
  'reply-mode':
    'Choose the optional automatic final-answer route, without sending. Input: {sessionId,operationId,mode:"conversation"|"reply"|"thread"|"none"}. Automatic final-answer forwarding is off by default.',
  policy: 'Read Channel policy. Input: {}.',
  'policy-set': 'CAS-save Channel policy. Input: {policy,expectedRevision}.',
  'execution-defaults': 'Read the CordisX profile defaults captured by newly created chats. Input: {}.',
  'execution-defaults-set':
    'CAS-save new-chat defaults. Input: {settings:{execution,approval,workMode,effort?,networkAccess?},expectedRevision}. Existing chats are preserved.',
  'execution-settings': 'Read one chat override and native application state. Input: {sessionId}.',
  'execution-settings-set':
    'Save one chat override for its next turn. Input: {sessionId,settings:object|null,expectedRevision}. null clears the override; never does not mean full access.',
  docs:
    'List or read packaged plugin documentation. Input: {pluginId?:string,id?:string,locale?:string}. Select pluginId to disambiguate a document ID. Read-only; never loads credential files.',
  'model-list': 'Read admitted providers/models and supported efforts. Input: {}.',
  'task-settings':
    'Read one Channel task model settings. Input: {sessionId?}. Incoming tasks retain --context from the prompt.',
  'task-settings-set':
    'Request an exact task change. Input: {sessionId?,settings:{providerId?,model?,effort?,fast?:boolean,projectId?},expectedRevision?}. Authorized users change directly; others receive an approval-required receipt. Idle application never interrupts the active turn. Native project IDs come from model-list.',
  'task-config': 'Read Channel-scoped creation defaults and field/provider/model permission rules. Input: {}.',
  'task-config-set':
    'Local-user CAS replacement of Channel task config. Input: {config:{defaults,scopes,permissions},expectedRevision}. Agent context cannot change global permission rules.',
  'task-requests':
    'Read pending task setting requests. Input: {}. Approval is through the authenticated Channel user command or card, never an Agent-claimed user.',
}
export function channelCliHelp(operation?: string): string {
  if (operation && HELP[operation]) {
    return `cordisx channel ${operation} [--profile <id>] [--context <incoming-context>] [--input <JSON>]\n${
      HELP[operation]
    }`
  }
  if (operation) throw new Error('INVALID_CHANNEL_OPERATION')
  return `cordisx channel <operation> [--profile <id>] [--input <JSON>]\n${
    Object.keys(HELP).join(' | ')
  }\nUse cordisx channel help <operation> for arguments. Reuses the exact running Host and its configured credentials.`
}
