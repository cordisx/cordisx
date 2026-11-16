import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { channelCommandHelp } from '../channel-command-registry.js'
import { type ChatExecutionSettings, parseChatExecutionSettings } from '../chat-execution-settings.js'
import type { ChannelChatBinding } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { type ChannelTargetAction, ChannelTargetChoices } from './channel-target-choice.js'
import { ChannelModelCommands } from './channel-model-commands.js'
import type { ChannelTaskSettings } from './channel-task-settings.js'

const same = (binding: ChannelChatBinding, event: ChannelEventRef) =>
  ['adapterId', 'accountId', 'tenantId', 'conversationId'].every(field =>
    (binding.channel as unknown as Record<string, unknown>)[field]
      === (event as unknown as Record<string, unknown>)[field]
  )

export class ChannelSessionCommands {
  private readonly choices = new ChannelTargetChoices()
  private readonly models: ChannelModelCommands
  constructor(
    private readonly input: {
      bindings(): readonly ChannelChatBinding[]
      native(): ChannelNativeSessions | undefined
      denied?(event: ChannelEventRef, command: string): boolean
      allowed(event: ChannelEventRef, command: string): boolean
      unbind(id: string): Promise<boolean>
      tasks?: ChannelTaskSettings
    },
  ) {
    this.models = new ChannelModelCommands({
      ...input,
      denied: (event, command) => input.denied?.(event, command) ?? false,
      choices: this.choices,
      targets: event => this.targets(event),
    })
  }
  private bindings(event: ChannelEventRef) {
    return this.input.bindings().filter(binding => binding.state === 'active' && same(binding, event))
  }
  private async targets(event: ChannelEventRef) {
    const ids = [...new Set(this.bindings(event).map(binding => binding.sessionId))]
    return Promise.all(
      ids.map(async id => ({ id, name: await this.input.native()?.label(id).catch(() => undefined) ?? 'Codex 对话' })),
    )
  }
  async handle(event: ChannelEventRef, command: string, argument: string): Promise<string | undefined> {
    const modelResult = await this.models.handle(event, command, argument)
    if (modelResult !== undefined) return modelResult
    if (command === 'help') return channelCommandHelp(argument, name => this.input.allowed(event, name))
    if (command === 'bind-status') {
      const targets = await this.targets(event)
      return targets.length
        ? `已绑定 ${targets.length} 个 Codex 对话：\n${
          targets.map((target, i) => `${i + 1}. ${target.name}`).join('\n')
        }`
        : '当前会话尚未绑定。用 /bind <对话 ID> 或 /bind new 开始。'
    }
    if (!['permissions', 'work-mode', 'choose', 'unbind'].includes(command)) return undefined
    const targets = await this.targets(event)
    if (command === 'choose') {
      const [token, selected, extra] = argument.trim().split(/\s+/u)
      if (!token || !selected || extra) return channelCommandHelp('choose')
      const choice = this.choices.take(event, token, selected, targets.map(target => target.id))
      if (choice.action.kind === 'model') return this.models.apply(event, choice.action, choice.targets)
      if (
        !(choice.action.kind === 'execution' && !choice.action.readOnly
          && Object.keys(choice.action.patch).every(field => field === 'effort')) && !this.input.allowed(
            event,
            choice.action.kind === 'execution' && choice.action.readOnly ? 'bind-status' : choice.command,
          )
      ) return '当前用户没有执行此操作的权限；未修改配置。'
      return this.apply(event, choice.action, choice.targets)
    }
    const parts = argument.trim().split(/\s+/u).filter(Boolean)
    let targetId: string | undefined, all = false
    const settings: Record<string, unknown> = {}
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      if (part === '--target') {
        targetId = parts[++i]
        if (!targetId) throw new Error('INVALID_COMMAND_ARGUMENTS')
      } else if (part === '--all' || command === 'unbind' && part === 'all') all = true
      else if (part === '--approval' || part === '--effort') {
        const value = parts[++i]
        if (!value) throw new Error('INVALID_COMMAND_ARGUMENTS')
        settings[part === '--approval' ? 'approval' : 'effort'] = value
      } else if (command === 'unbind') {
        if (targetId) throw new Error('INVALID_COMMAND_ARGUMENTS')
        targetId = part
      } else if (
        !part.startsWith('--') && settings[command === 'permissions' ? 'execution' : 'workMode'] === undefined
      ) {
        settings[command === 'permissions' ? 'execution' : 'workMode'] = part
      } else throw new Error('INVALID_COMMAND_ARGUMENTS')
    }
    if (all && targetId) throw new Error('INVALID_COMMAND_ARGUMENTS')
    const action: ChannelTargetAction = command === 'unbind' ? { kind: 'unbind' } : {
      kind: 'execution',
      patch: parseChatExecutionSettings(settings),
      readOnly: Object.keys(settings).length === 0,
    }
    if (
      !(action.kind === 'execution' && Object.keys(action.patch).every(field => field === 'effort'))
      && !this.input.allowed(event, action.kind === 'execution' && action.readOnly ? 'bind-status' : command)
    ) {
      return '当前用户没有执行此操作的权限；未修改配置。'
    }
    if (!targets.length) return '当前会话尚未绑定。用 /bind <对话 ID> 或 /bind new 开始，再设置权限。'
    const selected = targetId
      ? targets.filter(target => target.id === targetId)
      : all
      ? targets
      : targets.length === 1
      ? targets
      : []
    if (targetId && !selected.length) return '这个对话没有绑定到当前频道会话。用 /bind-status 查看可用目标。'
    if (!selected.length) return this.choices.offer(event, command, targets, action)
    return this.apply(event, action, selected)
  }
  private async apply(
    event: ChannelEventRef,
    action: ChannelTargetAction,
    targets: readonly { id: string; name: string }[],
  ) {
    const preferences = this.input.native()?.executionPreferences?.()
    const results: string[] = []
    for (const target of targets) {
      if (!this.bindings(event).some(binding => binding.sessionId === target.id)) {
        throw new Error('CHOICE_TARGET_CHANGED')
      }
      if (action.kind === 'unbind') {
        for (const binding of this.bindings(event).filter(binding => binding.sessionId === target.id)) {
          await this.input.unbind(binding.id)
        }
        results.push(`${target.name}：已解除绑定，对话保留。`)
      } else if (action.kind === 'execution') {
        if (action.patch.effort !== undefined && this.input.tasks) {
          const { effort, ...rest } = action.patch
          const result = await this.input.tasks.request(event, target.id, { effort }) as {
            application?: string
            requestId?: string
          }
          results.push(
            `${target.name}：${
              result.application === 'approval-required'
                ? `等待模型权限批准 ${result.requestId}`
                : '强度已保存，空闲后应用'
            }。`,
          )
          if (!Object.keys(rest).length) continue
        }
        if (!preferences) return '当前 Host 不支持会话执行配置。'
        const current = preferences.read('local', target.id)
        if (action.readOnly) {
          const settings = { ...current?.capturedDefaults, ...current?.override }
          results.push(
            `${target.name}：执行范围 ${settings.execution ?? 'inherit'}，审批 ${
              settings.approval ?? 'inherit'
            }，模式 ${settings.workMode ?? 'inherit'}，强度 ${settings.effort ?? 'inherit'}。${
              current?.application === 'saved'
                ? '已保存，下一 turn 生效。'
                : current?.application === 'applied'
                ? '原生已确认应用。'
                : '尚无原生应用读回。'
            }`,
          )
        } else {
          const { effort: _effort, ...rest } = action.patch
          const patch: ChatExecutionSettings = { ...current?.override, ...(this.input.tasks ? rest : action.patch) }
          await preferences.set('local', target.id, patch, current?.revision ?? 0)
          results.push(`${target.name}：已保存，下一 turn 应用。当前审批仍需单独批准或拒绝。`)
        }
      }
    }
    return results.join('\n')
  }
  dispose() {
    this.choices.dispose()
  }
}
