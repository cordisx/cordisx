import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelTaskSettings } from './channel-task-settings.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelTargetAction, ChannelTargetChoices } from './channel-target-choice.js'
import { parseChannelTaskPatch } from './channel-task-config.js'
import { channelCommandHelp } from '../channel-command-registry.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const CHANNEL_MODEL_COMMANDS: readonly string[] = [
  'model',
  'provider',
  'models',
  'fast',
  'project',
  'task-settings',
  'task-requests',
  'task-approve',
  'task-deny',
]
export class ChannelModelCommands {
  constructor(
    private readonly input: {
      tasks?: ChannelTaskSettings
      native(): ChannelNativeSessions | undefined
      choices: ChannelTargetChoices
      denied(event: ChannelEventRef, command: string): boolean
      targets(event: ChannelEventRef): Promise<readonly { id: string; name: string }[]>
    },
  ) {}
  async handle(event: ChannelEventRef, command: string, argument: string): Promise<string | undefined> {
    if (!CHANNEL_MODEL_COMMANDS.includes(command)) return undefined
    if (this.input.denied(event, command)) return '当前用户没有执行此指令的权限；未修改配置。'
    const tasks = this.input.tasks
    if (!tasks) return '当前 Host 不支持 Channel 模型设置。'
    if (command === 'models') {
      if (argument.trim()) return channelCommandHelp('models')
      const result = object(await tasks.catalog())
      return Array.isArray(result.providers)
        ? result.providers.map(object).map(provider =>
          `${provider.title ?? provider.providerId}（${provider.providerId}）：${
            Array.isArray(provider.models) ? provider.models.map(object).map(model => model.id).join('、') : ''
          }`
        ).join('\n')
        : '当前没有可用模型目录。'
    }
    if (command === 'task-requests') {
      if (argument.trim()) return channelCommandHelp(command)
      const rows = tasks.requests(event)
      return rows.length
        ? rows.map(row =>
          `${row.id} · ${row.state} · ${
            Object.entries(row.patch).map(([key, value]) => `${key}=${value}`).join(' ')
          }\n/task-approve ${row.id} 或 /task-deny ${row.id}`
        ).join('\n')
        : '当前会话没有模型配置申请。'
    }
    if (command === 'project' && argument.trim() === 'list') {
      const result = object(await tasks.catalog())
      if (result.projectAvailability === 'unavailable') return '当前运行环境没有可用的本地项目能力。'
      return Array.isArray(result.projects) && result.projects.length
        ? result.projects.map(object).map(project => `${project.name}（${project.projectId}）`).join('\n')
        : '当前没有可用的本地项目目录。'
    }
    if (command === 'task-approve' || command === 'task-deny') {
      if (!/^[a-f0-9]{8}$/u.test(argument.trim())) return channelCommandHelp(command)
      return tasks.answer(event, argument.trim(), command === 'task-deny' ? 'decline' : 'accept')
    }
    const args = argument.trim().split(/\s+/u).filter(Boolean)
    let targetId: string | undefined, all = false
    const patch: Record<string, unknown> = {}
    for (let i = 0; i < args.length; i++) {
      const item = args[i]!
      if (item === '--all') all = true
      else if (['--target', '--provider', '--model', '--effort', '--fast', '--project'].includes(item)) {
        const value = args[++i]
        if (!value || value.startsWith('--')) throw new Error('INVALID_COMMAND_ARGUMENTS')
        if (item === '--target') {
          if (targetId) throw new Error('INVALID_COMMAND_ARGUMENTS')
          targetId = value
        } else {
          const key = item === '--provider' ? 'providerId' : item === '--project' ? 'projectId' : item.slice(2)
          if (patch[key] !== undefined) throw new Error('INVALID_COMMAND_ARGUMENTS')
          if (key === 'fast' && !['true', 'false', 'on', 'off'].includes(value)) {
            throw new Error('INVALID_COMMAND_ARGUMENTS')
          }
          patch[key] = key === 'fast' ? ['true', 'on'].includes(value) : value
        }
      } else if (!item.startsWith('--') && ['model', 'provider', 'fast', 'project'].includes(command)) {
        const key = command === 'model'
          ? 'model'
          : command === 'provider'
          ? 'providerId'
          : command === 'project'
          ? 'projectId'
          : 'fast'
        if (patch[key] !== undefined) throw new Error('INVALID_COMMAND_ARGUMENTS')
        if (key === 'fast' && !['true', 'false', 'on', 'off'].includes(item)) {
          throw new Error('INVALID_COMMAND_ARGUMENTS')
        }
        patch[key] = key === 'fast' ? ['true', 'on'].includes(item) : item
      } else throw new Error('INVALID_COMMAND_ARGUMENTS')
    }
    if (all && targetId) throw new Error('INVALID_COMMAND_ARGUMENTS')
    const action: Extract<ChannelTargetAction, { kind: 'model' }> = {
      kind: 'model',
      patch: parseChannelTaskPatch(patch),
      readOnly: !Object.keys(patch).length,
    }
    const targets = await this.input.targets(event)
    if (!targets.length) return '当前会话尚未绑定。用 /bind <对话 ID> 或 /bind new 开始。'
    const selected = targetId
      ? targets.filter(target => target.id === targetId)
      : all || targets.length === 1
      ? targets
      : []
    if (targetId && !selected.length) return '这个对话没有绑定到当前频道会话。用 /bind-status 查看目标。'
    if (!selected.length) return this.input.choices.offer(event, command, targets, action)
    return this.apply(event, action, selected)
  }
  async apply(
    event: ChannelEventRef,
    action: Extract<ChannelTargetAction, { kind: 'model' }>,
    targets: readonly { id: string; name: string }[],
  ) {
    const results: string[] = []
    for (const target of targets) {
      if (!this.input.tasks?.boundTo(event, target.id)) throw new Error('CHOICE_TARGET_CHANGED')
      const current = await this.input.tasks.read(target.id)
      if (action.readOnly) {
        results.push(
          `${target.name}：服务商 ${current.settings.providerId ?? '未知'}，模型 ${
            current.settings.model ?? '未知'
          }，强度 ${current.settings.effort ?? '继承'}，Fast ${
            current.settings.fast === undefined ? '未知' : current.settings.fast ? '开启' : '关闭'
          }，项目 ${current.settings.projectId ?? '未绑定'}${current.pending ? '；有待应用配置' : ''}。${
            current.code === 'NATIVE_PROVIDER_SWITCH_UNAVAILABLE'
              ? '当前对话不能切换服务商；可保留此对话，新建对话并选择目标服务商。'
              : current.application === 'unknown'
              ? '上次更改的结果尚未确认；请先核对实际状态，不要重复提交。'
              : ''
          }`,
        )
      } else {
        const result = object(await this.input.tasks.request(event, target.id, action.patch, current.revision))
        results.push(
          `${target.name}：${
            result.application === 'approval-required'
              ? `等待有对应模型权限的用户批准 ${result.requestId}`
              : '已保存，空闲后应用'
          }。`,
        )
      }
    }
    return results.join('\n')
  }
}
