const HELP: Readonly<Record<string, string>> = {
  connections: 'List configured live Channel connections. Input: {}.',
  conversations: 'List conversations with readable names. Input: {account:{adapterId,accountId,tenantId}}.',
  bind:
    'Bind a chat to a conversation. Input: {sessionId,channel:{adapterId,accountId,tenantId,conversationId,kind,threadId,semantics},mode:"listen"|"deliver",autoReply?:false}. Bindings have no cardinality cap.',
  unbind: 'Remove bindings without deleting chats. Input: {sessionId,bindingId?:string,channel?:object}.',
  'bind-status': 'Read bindings and jobs for a chat. Input: {sessionId}.',
  'local-bindings':
    'Local CLI only: list profile bindings, optionally filtered. Input: {account?:{adapterId,accountId,tenantId},conversationId?:string}.',
  'admin-pair-begin':
    'Local user only: issue a five-minute single-use pairing code. Input: {account:{adapterId,accountId,tenantId}}. Send /pair <code> privately to that bot; keep the code secret.',
  'admin-pair-status': 'Local user only: inspect a pairing candidate before confirmation. Input: {pairingId}.',
  'admin-pair-confirm':
    'Local user only: confirm the displayed user and direct chat. Input: {pairingId}. This grants scoped management commands, not task dispatch.',
  'admin-pair-cancel': 'Local user only: cancel a pending pairing. Input: {pairingId}.',
  'continuation-policy': 'Local user only: read continuation policy and checkpoint state. Input: {sessionId}.',
  'continuation-policy-set':
    'Local user only: configure best-effort idle-boundary continuation. Input: {sessionId,policy:{enabled:boolean,threshold:number,reserveTokens:integer,maxAgeMs:integer}}. Disabled by default; no guarantee against compaction.',
  'continuation-start':
    'Local user only: start a fresh Channel task using its explicit checkpoint. Input: {sessionId}. An uncertain result must be inspected, never blindly repeated.',
  'logical-mode-default':
    'Local user only: read the profile continuation mode preference. Input: {}. A preference does not grant history access.',
  'logical-mode-default-set':
    'Local user only: set or clear the profile continuation mode preference. Input: {mode:"linked"|"fork"|null,expectedRevision:integer}. History still requires explicit consent.',
  'logical-mode-conversation':
    'Local user only: read the effective continuation preference and conversation revision. Input: {sessionId}.',
  'logical-mode-conversation-set':
    'Local user only: set or clear one conversation override. Input: {sessionId,mode:"linked"|"fork"|null,expectedRevision:integer,expectedConversationId:string}; read both expected values first. History still requires explicit consent.',
  'logical-status':
    'Local user only: inspect up to 64 continuation operations for a source session. Input: {sessionId,operationId?}. Unknown results must be checked before any retry.',
  'logical-chain':
    'Local user only: inspect confirmed session boundaries ending at a destination. Input: {sessionId}. This does not disclose history or grant access.',
  'logical-abandon':
    'Local user only: after inspecting an unknown Desktop operation, accept a possible orphan and release its fence when the owner confirms no outstanding native writes. Input: {sessionId,operationId,confirmOrphanPossible:true}. No destination is deleted or retried.',
  'continuation-checkpoint': 'Active Channel turn with --context only: read this task checkpoint. Input: {}.',
  'continuation-checkpoint-set':
    'Active Channel turn with --context only: save an explicit handoff. Input: {expectedRevision,checkpoint:{goal,constraints,completed,remaining,history,continueAtIdle:boolean}}. Use the revision returned by continuation-checkpoint; it is 0 when no checkpoint exists. Text is bounded; source session is assigned by the Host.',
  'continuation-history':
    'Active Channel continuation turn with --context only: read one bounded page from its confirmed source. Input: {limit?:1..32,cursor?:string}. No arbitrary source session is accepted.',
  history:
    'Retrieve accepted messages from all the chat bindings. Input: {sessionId,afterSequence?:number,limit?:number}.',
  'remote-history':
    'Read one remote Feishu/Lark page. Input: {account,conversationId,kind:"direct"|"group",startTime,endTime,pageSize?:1..50,pageToken?:string,order?:"asc"|"desc"}. Times are Unix seconds as decimal strings or integers; use hasMore/pageToken for continuation. Requires message read scope.',
  'message-get':
    'Read a Feishu/Lark message. Input: {account,conversationId,kind:"direct"|"group",messageId}. A Channel turn may only read its own reply ancestry; platform read permissions still apply.',
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
  if (operation === 'memory-guide') {
    return 'cordisx channel memory guide --context <incoming-context> --input {"topic":"write"}\nOmit topic for navigation; topics: write, organize, recall. Describes implemented operations and missing organization/provider capabilities only.'
  }
  if (operation === 'memory') {
    return 'cordisx channel memory guide|navigate|search-page|batch|remember|get|search|update|forget|index|grant|revoke|grant-list|identity-challenge|identity-confirm|identity-unbind --context <incoming-context> [--profile <id>] --input <JSON>\nStart with guide {}. navigate/search-page support cursor,limit,maxBytes; batch uses ids,maxBytes. Records: {record:{kind,title,summary,tags,entityRefs,evidenceType,confidence,expiresAt?,observedAt?}}. Changes require id/revision. grant input {grant:{source:string,target:{kind:"conversation",id:string},expiresAt?,recordIds?}} uses configured authority and explicit incoming request. identity-challenge {target:accountUserTuple}; identity-confirm {challenge} requires the actual second account request. Actor/admin/intent are never accepted from input.'
  }
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
