import type { Context } from '@deepseek-ai/cordis'
import type { ChannelManagerFormOptionsV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelSettingsFormSectionV2 } from '@cordisx/protocol/channel-manager/v12'
import { managedConsoleSeatFor } from './managed-console-seats.js'
import type { ChannelManagerState } from './channel-manager-state.js'

/** Both frozen general forms and Channel-overlay forms keep the same caller, seat and permission boundary. */
export async function mountChannelManagerSettings(input: {
  ctx: Context
  owner: string
  caller: string
  state: ChannelManagerState
  section: ChannelSettingsFormSectionV2 | 'channel-new-chats'
  target: HTMLElement
  options: ChannelManagerFormOptionsV1
  live(): boolean
  authorizeRead(): Promise<boolean>
  authorizeWrite(): Promise<boolean>
}) {
  if (
    !['new-chats', 'channel-new-chats', 'messages', 'permissions', 'organization', 'task-models'].includes(
      input.section,
    )
    || !managedConsoleSeatFor(input.target, input.owner) || input.options.signal.aborted
    || !await input.authorizeRead()
  ) return { status: 'unavailable' as const, code: 'HOST_FORM_UNAVAILABLE' }
  const execution = input.section === 'channel-new-chats' ? input.state.creationExecution : input.state.execution
  return input.state.settings.mount({
    ctx: input.ctx,
    caller: input.caller,
    pageOwner: input.owner,
    section: input.section,
    target: input.target,
    options: input.options,
    ...(input.state.policy === undefined ? {} : { policy: input.state.policy }),
    ...(execution === undefined ? {} : { execution }),
    ...(input.state.tasks === undefined ? {} : { tasks: input.state.tasks }),
    live: input.live,
    authorizeWrite: input.authorizeWrite,
  })
}
