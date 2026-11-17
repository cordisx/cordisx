import { fileURLToPath } from 'node:url'

export interface ChannelNativeCliContext {
  readonly node: string
  readonly entry: string
  readonly home: string
  readonly profile: string
}

/** Use the active Host package and selected profile, never a different CLI found on PATH. */
export function configuredChannelCliContext(home: string, profile: string): ChannelNativeCliContext {
  return { node: process.execPath, entry: fileURLToPath(new URL('../cli.js', import.meta.url)), home, profile }
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Only executable/configuration paths and a profile identifier are exposed; no credential or RPC token. */
export function channelCliSendInstructions(
  context: ChannelNativeCliContext | undefined,
  token?: string,
): readonly string[] {
  if (!context) {
    return [
      'Use the configured Channel CLI to send messages. If its runtime scope is unavailable, report that locally; do not forward your final answer.',
    ]
  }
  const prefix = `env CORDISX_HOME=${quote(context.home)} ${quote(context.node)} ${quote(context.entry)} channel`
  const scope = `--profile ${quote(context.profile)}${token ? ` --context ${quote(token)}` : ''}`
  return [
    `Read the installed Channel manual with ${prefix} docs ${scope} --input '{"pluginId":"channel","id":"usage"}'. Use help <operation> for exact arguments.`,
    `Use this exact running Host CLI: ${prefix} send ${scope} --input '<JSON>'.`,
    `For historical context use ${prefix} remote-history ${scope} --input '<JSON>' with {account,conversationId,kind,startTime,endTime,pageSize?,pageToken?,order?}. Times are Unix seconds as decimal strings or integers; kind is direct or group. Read hasMore/pageToken and request only needed pages.`,
    'Local history contains accepted inputs after the active binding, not complete remote history. Remote history requires message read scope and may not include all thread replies; report permission errors and incompleteness.',
    'For the official Lark CLI/Skill, check command -v lark-cli, then use lark-cli skills read lark-shared, lark-im, and the chat-messages-list reference. Use only an explicitly confirmed matching --profile and --as bot; never switch identity or authorize silently. If unavailable, consult https://github.com/larksuite/cli for installation.',
    'The send JSON is {account:{adapterId,accountId,tenantId},target:{id,kind,replyMode,replyTo?},text,operationId}.',
    'Use the incoming source account and conversation identifiers below for a reply; do not guess another account or destination.',
    'Choose target.replyMode per send: conversation posts in the main stream; reply quotes replyTo; thread replies in a topic. Reply/thread require the source messageId as replyTo.',
    `To ask a question with optional choices, use ${prefix} ask ${scope} --input '<JSON>'; the input is {account,target:{id,kind,replyMode?,replyTo?},question,options:[{label,value}],targetUserId?,operationId,expiresInSeconds?}.`,
    'Prefer the external Channel CLI when asking a channel user: choose plain send or ask as appropriate. Native request_user_input is often invisible to the external user. After sending, end your turn and wait for a subsequent Channel user message; do not expect the CLI call to wait for an answer.',
    'A card button or submitted card text is a user answer; the user may also send free text under the normal message policy (group replies may need to mention the bot or use a wake prefix). Unsupported platforms receive a numbered text question, not clickable buttons. Never assume an answer was received just because a question was sent.',
    'For multiple destinations use send-many with targets. Choose one stable operationId per explicit send and read receipt after uncertainty; never blindly resend.',
    'Pass JSON through proper shell quoting or spawn argument arrays. The CLI reuses this runtime connection and credentials; do not start another service or ask for keys.',
    'Keep --context for all operations: it identifies this real incoming message. It does not grant additional account, destination or configuration permissions.',
  ]
}
