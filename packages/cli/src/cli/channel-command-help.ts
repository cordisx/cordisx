const HELP: Readonly<Record<string, string>> = {
  connections: 'List configured live Channel connections. Input: {}.',
  conversations: 'List conversations with readable names. Input: {account:{adapterId,accountId,tenantId}}.',
  bind:
    'Bind a chat to a conversation. Input: {sessionId,channel:{adapterId,accountId,tenantId,conversationId,kind,threadId,semantics},mode:"listen"|"deliver",autoReply?:false}. Bindings have no cardinality cap.',
  unbind: 'Remove bindings without deleting chats. Input: {sessionId,bindingId?:string,channel?:object}.',
  'bind-status': 'Read bindings and jobs for a chat. Input: {sessionId}.',
  history:
    'Retrieve accepted messages from all the chat bindings. Input: {sessionId,afterSequence?:number,limit?:number}.',
  listen:
    'Wait for messages in multiple conversations. Input: {account,conversationIds:[string],afterCursor?:string,timeoutSeconds?:0..60}.',
  send:
    'Send explicitly. Input: {account,target:{id,kind,replyMode:"conversation"|"reply"|"thread",replyTo?:messageId},text,operationId}. Quote JSON safely. Only receipt.state=sent proves delivery.',
  'send-many':
    'Send explicitly to multiple destinations. Input: {account,targets:[target],text,operationId}. Validate the whole batch first; receipts report each target.',
  receipt:
    'Read an earlier send without resending. Input: {account,operationId,targetCount?:number}. Returns deliveryState and explicit receipt:null for not-found; not-found alone never proves a disconnected request was not sent.',
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
}
export function channelCliHelp(operation?: string): string {
  if (operation && HELP[operation]) {
    return `cordisx channel ${operation} [--profile <id>] [--input <JSON>]\n${HELP[operation]}`
  }
  if (operation) throw new Error('INVALID_CHANNEL_OPERATION')
  return `cordisx channel <operation> [--profile <id>] [--input <JSON>]\n${
    Object.keys(HELP).join(' | ')
  }\nUse cordisx channel help <operation> for arguments. Reuses the exact running Host and its configured credentials.`
}
