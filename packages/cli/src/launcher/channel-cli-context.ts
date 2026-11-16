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
export function channelCliSendInstructions(context: ChannelNativeCliContext | undefined): readonly string[] {
  if (!context) {
    return [
      'Use the configured Channel CLI to send messages. If its runtime scope is unavailable, report that locally; do not forward your final answer.',
    ]
  }
  const prefix = `env CORDISX_HOME=${quote(context.home)} ${quote(context.node)} ${quote(context.entry)} channel`
  return [
    `Read the installed Channel manual with ${prefix} docs --profile ${
      quote(context.profile)
    } --input '{"pluginId":"channel","id":"usage"}'. Use help <operation> for exact arguments.`,
    `Use this exact running Host CLI: ${prefix} send --profile ${quote(context.profile)} --input '<JSON>'.`,
    'The send JSON is {account:{adapterId,accountId,tenantId},target:{id,kind,replyMode,replyTo?},text,operationId}.',
    'Use the incoming source account and conversation identifiers below for a reply; do not guess another account or destination.',
    'Choose target.replyMode per send: conversation posts in the main stream; reply quotes replyTo; thread replies in a topic. Reply/thread require the source messageId as replyTo.',
    'For multiple destinations use send-many with targets. Choose one stable operationId per explicit send and read receipt after uncertainty; never blindly resend.',
    'Pass JSON through proper shell quoting or spawn argument arrays. The CLI reuses this runtime connection and credentials; do not start another service or ask for keys.',
  ]
}
