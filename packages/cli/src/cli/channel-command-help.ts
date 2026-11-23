import { CHANNEL_FORWARD_HELP } from './channel-forward-help.js'

const HELP: Readonly<Record<string, string>> = {
  ...CHANNEL_FORWARD_HELP,
  'media-prepare':
    'Candidate three-step Host upload; installed support is not implied. Use media-prepare begin|chunk|commit [--profile <id>] [--context <incoming-context>] --input <JSON>. begin: {account,target,operationId,type:"image"|"audio"|"file"|"video",format,filename?,mediaType?,durationMs?,size,sha256}. Formats: image png/jpeg, audio opus, file pdf/binary, video mp4. filename required for file/video; optional mediaType must match format, name is a consistent filename alias. chunk: {uploadId,offset,bytesBase64}; offset is a byte offset, each decoded chunk is 1..65536 bytes, canonical base64 only. commit: {uploadId}. Returned Host result is printed unchanged; preserve its uploadId and committed media handle. Host binds caller/context/target, verifies size/hash, and judges platform capability. No Host path reads, CLI file reads, SDK sends, caller-claimed grants or automatic retries. Each complete RPC must be under 256 KiB. Use media: handle in send payload; inspect uncertain outcomes before retrying.',
  'user-access':
    'Incoming --context required. Input: {user:"original ID, native @ mention or full name",scope?:"conversation"|"account"}. Read this managed user rule, revision and effective ordinary dispatch policy. Requires one of the existing user-management permissions. Account scope requires a global command grant; no other account is accepted.',
  'user-access-set':
    'Incoming --context required. Input: {user,scope?:"conversation"|"account",effect:"allow"|"deny"|"reset",expectedRevision}. Requires the matching allow-user/deny-user/reset-user permission and an explicit original request naming that same target. Examples: 给 @用户 授权; 禁止 @用户 发起任务; 恢复 @用户 权限. In a group, allow grants only that user future mentioned tasks, bypassing positive dispatch lists but never explicit denies. Direct/account rules retain positive-list intersections. Account scope requires 在本账号 plus a global command grant. Ambiguous names need a new explicit request with native mention/ID; do not choose a candidate yourself. Reset removes only this managed rule/grant, never other denials or command grants.',
  'group-block':
    'Incoming --context required. Input: {}. Read this group managed task block, revision and restore capability.',
  'group-block-set':
    'Incoming --context required. Input: {blocked:boolean,expectedRevision}. Explicit 禁止本群任务 requires messages-off permission; 恢复本群任务 requires messages-on. Only the current group is accepted. A blocked group accepts the addressed authorized restore request only if other task rules permit it. Other messages remain blocked. Restore removes only the managed block, not other denies; /messages-on remains available. Do not replay uncertain writes.',
  'group-access':
    'Incoming --context required: read this exact group task whitelist and revision. Input: {}. No caller-selected account, group or actor.',
  'group-access-set':
    'Incoming --context required. Input: {enabled:boolean,expectedRevision:integer}. An explicit current-group request requires allow-user permission to enable, reset-user permission to revoke. Later @ messages can initiate tasks; explicit denies win. Other groups, private chats, send and management permissions remain unchanged. Re-read a revision conflict; do not replay uncertain writes.',
  reaction:
    'Incoming --context required. React to that known source message only. Input: {action:"add",emojiType:"OnIt"} or {action:"remove",reactionId:"returned-id"}. Remove only reactions this bot created. Preserve receipt reactionId; unknown API outcome is not success and must not be blindly retried. Completion emoji is separately configured, never literal "done".',
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
  'message-capabilities':
    'Discover implemented operations, restrictions and permission alternatives, not permission success. Input: {account,conversationId,kind}.',
  'message-operation-receipt':
    'Read a durable operation without replay. Input: {account,conversationId,kind,operationId}. null is not proof of no effect; unknown writes must not be blindly repeated with new IDs.',
  'message-edit':
    'Edit an owned text/post message with the same type. Input: {account,conversationId,kind,messageId,operationId,content:{type:"text",text}|{type:"richtext",blocks:[{text,style}]}}. Stable operationId; platform edit window and count apply.',
  'message-recall':
    'Recall only this bot’s message, not local history deletion. Input: {account,conversationId,kind,messageId,operationId}. Platform recall window applies. Unknown effects are not replayed.',
  'pin-add':
    'Pin a visible exact-conversation message. Input: {account,conversationId,kind,messageId,operationId}. Requires platform pin permission; preserve operationId.',
  'pin-remove':
    'Unpin a visible exact-conversation message. Input: {account,conversationId,kind,messageId,operationId}. Preserve operationId; not message deletion.',
  'pin-list':
    'Read one group pin page. Input: {account,conversationId,kind:"group",pageSize?:1..50,pageToken?,startTime?,endTime?}. Times are decimal milliseconds; no automatic traversal.',
  'read-users':
    'Read one page for this bot’s own message, at most 7 days old. Input: {account,conversationId,kind,messageId,pageSize?:1..50,pageToken?}. Reading is not approval or completion.',
  'reaction-list':
    'Read one reaction page; Channel callers may only inspect their incoming source message. Input: {account,conversationId,kind,messageId,pageSize?:1..50,pageToken?,emojiType?}. Existing reaction add/remove remains separate.',
  'card-update':
    'Update an owned plain notice/status card, never an approval/question control card. Input: {account,conversationId,kind,messageId,operationId,card:{template:"notice"|"status",title,body,status?:"pending"|"running"|"completed"|"failed"}}. Status template requires status; no raw vendor JSON or generic card actions.',
  listen:
    'Wait for messages in multiple conversations. Input: {account,conversationIds:[string],afterCursor?:string,timeoutSeconds?:0..60}.',
  send:
    'Send explicitly through the configured Host. Prefer richtext for ordinary prose, progress and results, even a single plain block. Input: {account,target:{id,kind,replyMode:"conversation"|"reply"|"thread",replyTo?:messageId},content:{type:"richtext",blocks:[{text:"Message",style:"plain"}]},operationId}; payload is a content alias, never combine content fields. Use text only for verbatim original text, an explicit plain-text request, or Host/platform compatibility without richtext support. Legacy top-level text and payload/content:{type:"text",text} retain plain-text wire semantics; no implicit text-to-richtext conversion. Blocks carry literal text and styles, not Markdown parsing. For a native mention followed by inline explanation use {type:"paragraph",nodes:[{type:"mention",userId:"ou_verified"},{type:"text",text:" please review",style:"plain"}]}; each paragraph is one line, while legacy text/style blocks retain separate lines. Only exact user IDs verified by accepted sender evidence in the same account/tenant/conversation and active connection are accepted; never guess IDs from names or use @all. Richtext support alone is not paragraph/mention support. No new permission scopes; identity/permission failures never fall back. Image/audio/video/file use {type,handle:"media:opaque-id"}. Richtext: {type:"richtext",blocks:[{text,style:"plain"|"strong"|"emphasis"|"code"}]} with 1..128 blocks, each text 1..4096. Card: {type:"card",title:1..256,body:1..16384}; no raw platform card or card handle. Optional fallback:{mode:"reject"} or {mode:"text",text} applies only to unsupported message types, not send failures. Nontext is forwarded unchanged for Host capability judgment; CLI validation does not imply platform support. No local paths, URLs, base64 in send, SDK sending, or permission grants. Host must authorize media handles and advertise support per platform/type. For Host progress reminders copy the notice progressToken into the send JSON; stale tokens reject and queued progress is cancelled after new input or confirmed reply. The token grants no permission. Only receipt.state=sent proves delivery; inspect receipt after uncertainty, never blindly resend.',
  'send-many':
    'Send explicitly to multiple destinations through the configured Host. Prefer richtext for ordinary prose, progress and results. Input: {account,targets:[target],content:{type:"richtext",blocks:[{text:"Message",style:"plain"}]},operationId}; payload is a content alias. Use text only for verbatim original text, an explicit plain-text request, or Host/platform compatibility without richtext support; top-level text and typed text retain plain-text wire semantics. Same typed content and explicit fallback rules as send; no text fallback unless requested for unsupported types. Host validates the whole batch before its first effect, including permissions and platform capabilities; receipts report each target. Inspect receipt after uncertainty, never blindly resend.',
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
