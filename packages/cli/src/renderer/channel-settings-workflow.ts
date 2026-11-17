import type { ChannelManagerFormOptionsV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelSettingsFormSectionV2 } from '@cordisx/protocol/channel-manager/v12'
import { ChannelSettingsDraft } from './channel-settings-draft.js'
import type { ChannelPolicyWorkflow } from './channel-policy-workflow.js'
import type { ChannelExecutionWorkflow } from './channel-execution-workflow.js'
import type { ChannelTaskSettingsWorkflow } from './channel-task-settings-workflow.js'
import type { Context } from '@deepseek-ai/cordis'

/** Draft lifetimes follow the actual caller, never a borrowed service facade. */
export class ChannelSettingsWorkflow {
  private readonly owners = new Map<
    string,
    {
      policy: ChannelSettingsDraft
      execution: ChannelSettingsDraft
      channelExecution: ChannelSettingsDraft
      tasks: ChannelSettingsDraft
    }
  >()
  retire(owner: string): void {
    this.owners.delete(owner)
  }
  clear(): void {
    this.owners.clear()
  }
  async mount(input: {
    readonly ctx: Context
    readonly caller: string
    readonly pageOwner: string
    readonly section: ChannelSettingsFormSectionV2 | 'channel-new-chats'
    readonly target: HTMLElement
    readonly options: ChannelManagerFormOptionsV1
    readonly policy?: ChannelPolicyWorkflow
    readonly execution?: ChannelExecutionWorkflow
    readonly tasks?: ChannelTaskSettingsWorkflow
    readonly live: () => boolean
    readonly authorizeWrite: () => Promise<boolean>
  }) {
    if (input.options.signal.aborted || !input.live()) {
      return { status: 'unavailable' as const, code: 'HOST_FORM_UNAVAILABLE' }
    }
    let drafts = this.owners.get(input.caller)
    if (!drafts) {
      drafts = {
        policy: new ChannelSettingsDraft(),
        execution: new ChannelSettingsDraft(),
        channelExecution: new ChannelSettingsDraft(),
        tasks: new ChannelSettingsDraft(),
      }
      this.owners.set(input.caller, drafts)
      input.ctx.effect(() => () => this.retire(input.caller), 'channelManager settings draft lifetime')
    }
    const lifetime = new AbortController()
    const dispose = input.ctx.effect(() => () => lifetime.abort(), 'channelManager settings form lifetime')
    const options = { ...input.options, signal: AbortSignal.any([input.options.signal, lifetime.signal]) }
    try {
      const result = input.section === 'task-models'
        ? input.tasks
          ? await input.tasks.mount({
            target: input.target,
            owner: input.pageOwner,
            options,
            live: input.live,
            authorize: input.authorizeWrite,
            draft: drafts.tasks,
          })
          : { status: 'unavailable' as const, code: 'TASK_SETTINGS_UNAVAILABLE' }
        : input.section === 'new-chats' || input.section === 'channel-new-chats'
        ? input.execution
          ? await input.execution.mount({
            target: input.target,
            owner: input.pageOwner,
            options,
            live: input.live,
            authorize: input.authorizeWrite,
            draft: input.section === 'channel-new-chats' ? drafts.channelExecution : drafts.execution,
          })
          : { status: 'unavailable' as const, code: 'EXECUTION_SETTINGS_UNAVAILABLE' }
        : input.policy
        ? await input.policy.mount(input.pageOwner, input.target, options, input.live, input.authorizeWrite, true, {
          draft: drafts.policy,
          section: input.section,
        })
        : { status: 'unavailable' as const, code: 'CHANNEL_POLICY_UNAVAILABLE' }
      if (result.status === 'mounted') void result.closed.then(() => dispose())
      else dispose()
      return result
    } catch {
      dispose()
      return { status: 'unavailable' as const, code: 'HOST_FORM_UNAVAILABLE' }
    }
  }
}
