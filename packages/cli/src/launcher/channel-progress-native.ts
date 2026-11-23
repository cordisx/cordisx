import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelNativeCliContext } from './channel-cli-context.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'
import { channelSteerNotActive } from './channel-native-steer-error.js'
import { sameChannelPrincipal } from './channel-source-principal.js'

export interface ChannelProgressNotice {
  readonly source: ChannelEventRef
  readonly sessionId: string
  readonly turnId: string
  readonly token: string
  readonly finishSeconds: number
  readonly reminder: number
}
export type ChannelProgressResult = 'accepted' | 'rejected' | 'unknown'
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** A Host notice to the existing turn. No new task, Channel input or claimed user utterance is created. */
export async function channelProgressNative(input: {
  notice: ChannelProgressNotice
  cli: ChannelNativeCliContext | undefined
  source: ChannelEventRef | undefined
  context: string | undefined
  current(): boolean
  request(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
}): Promise<ChannelProgressResult> {
  const { notice, cli, context } = input
  if (!cli || !context || !input.source || !sameChannelPrincipal(input.source, notice.source) || !input.current()) {
    return 'rejected'
  }
  const command = `env CORDISX_HOME=${quote(cli.home)} ${quote(cli.node)} ${quote(cli.entry)} channel send --profile ${
    quote(cli.profile)
  } --context ${quote(context)}`
  const prompt = [
    '[CordisX Host progress reminder; this is not a new user message or task.]',
    `No confirmed reply has been sent after the latest accepted input. This is reminder ${notice.reminder}.`,
    ...(notice.reminder > 1
      ? [
        'The previous reminder still produced no confirmed user reply. Check why: if tool execution is blocking the send, explain the real blocker when you can. Send one useful current update, not repeated canned text.',
      ]
      : []),
    `Assess whether you can finish the current work within ${notice.finishSeconds} seconds. If not, send a concise, factual progress update or explain what is blocking you to the current Channel user through the existing CLI. Do not invent progress or claim the task is complete.`,
    'A tool call, queued message or reaction does not count as a sent reply. If a previous send is uncertain, inspect its receipt; do not resend the same effect.',
    `Use ${command} --input '<JSON>' with the original source account and intended reply route. Include progressToken:${
      JSON.stringify(notice.token)
    } in that send JSON so the Host rejects this reminder after new user input or confirmed delivery. Keep a stable operationId.`,
    'New user input supersedes this notice. Do not send an old canned waiting message or change task/configuration permissions. Continue the current work.',
  ].join('\n')
  if (!input.current()) return 'rejected'
  try {
    const result = await input.request('turn/steer', {
      threadId: notice.sessionId,
      expectedTurnId: notice.turnId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    }) as { turnId?: string; cordisxSteerRejected?: boolean } | undefined
    return result?.cordisxSteerRejected === true
      ? 'rejected'
      : result?.turnId === notice.turnId
      ? 'accepted'
      : 'unknown'
  } catch (error) {
    return channelSteerNotActive(error, notice.turnId) ? 'rejected' : 'unknown'
  }
}
