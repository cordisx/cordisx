import { createElement } from 'react'
import type { ChatExecutionReadbackV1, ChatExecutionSettingsV1 } from '@cordisx/protocol/chat-execution-settings/v1'
import type { ChannelManagerFormOptionsV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelManagerActionsApi } from './channel-manager.js'
import { parseChatExecutionSettings } from '../chat-execution-settings.js'
import { ChatExecutionForm } from './chat-execution-form.js'
import { mountChannelHostForm } from './channel-form-mount.js'
import type { ChannelSettingsDraft } from './channel-settings-draft.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function effectiveSettings(value: unknown): ChatExecutionSettingsV1 {
  const current = object(value), sandbox = object(current.sandbox)
  return {
    ...(sandbox.type === 'dangerFullAccess'
      ? { execution: 'full-access' as const }
      : sandbox.type === 'workspaceWrite'
      ? { execution: 'workspace-write' as const }
      : sandbox.type === 'readOnly'
      ? { execution: 'read-only' as const }
      : {}),
    ...(['untrusted', 'on-request', 'never'].includes(String(current.approvalPolicy))
      ? { approval: current.approvalPolicy as 'untrusted' | 'on-request' | 'never' }
      : {}),
    ...(['default', 'plan'].includes(String(current.workMode))
      ? { workMode: current.workMode as 'default' | 'plan' }
      : {}),
    ...(typeof current.reasoningEffort === 'string' ? { effort: current.reasoningEffort } : {}),
    ...(typeof sandbox.networkAccess === 'boolean' ? { networkAccess: sandbox.networkAccess } : {}),
  }
}
export class ChannelExecutionWorkflow {
  constructor(
    private readonly input: {
      document: Document
      profileId: string
      hostGeneration: string
      lifetime: AbortSignal
      live?: () => boolean
      defaultsScope?: 'channel'
      run: ChannelManagerActionsApi['run']
    },
  ) {}
  async read(sessionId: string | undefined, signal: AbortSignal): Promise<ChatExecutionReadbackV1> {
    signal.throwIfAborted()
    this.input.lifetime.throwIfAborted()
    if (this.input.live?.() === false) throw new Error('STALE_GENERATION')
    const result = await this.input.run(
      sessionId ? 'execution-settings' : this.defaultsAction(),
      sessionId ? { sessionId } : {},
    )
    signal.throwIfAborted()
    this.input.lifetime.throwIfAborted()
    if (this.input.live?.() === false) throw new Error('STALE_GENERATION')
    if (result.status !== 'applied' || !result.execution) {
      throw new Error(result.code ?? 'EXECUTION_SETTINGS_UNAVAILABLE')
    }
    return this.project(result.execution, sessionId)
  }
  private defaultsAction() {
    return this.input.defaultsScope === 'channel'
      ? 'channel-execution-defaults' as const
      : 'execution-defaults' as const
  }
  private defaultsSaveAction() {
    return this.input.defaultsScope === 'channel'
      ? 'channel-execution-defaults-set' as const
      : 'execution-defaults-set' as const
  }
  private project(value: unknown, sessionId: string | undefined): ChatExecutionReadbackV1 {
    const response = object(value), record = sessionId ? object(response.settings) : response
    return {
      contract: 'cordisx.chat-execution-readback/v1',
      schemaVersion: 1,
      profileId: this.input.profileId,
      hostGeneration: this.input.hostGeneration,
      revision: Number.isSafeInteger(record.revision) ? Number(record.revision) : 0,
      scope: sessionId ? 'chat' : 'creation-defaults',
      settings: parseChatExecutionSettings(
        sessionId ? { ...object(record.capturedDefaults), ...object(record.override) } : record.settings,
      ),
      application:
        sessionId && ['saved', 'submitted', 'applied', 'restricted', 'unknown'].includes(String(record.application))
          ? record.application as ChatExecutionReadbackV1['application']
          : sessionId
          ? 'unknown'
          : 'saved',
      ...(record.effective === undefined ? {} : { effective: effectiveSettings(record.effective) }),
      ...(typeof record.code === 'string' && /^[A-Z_]+$/u.test(record.code) ? { code: record.code } : {}),
    }
  }
  async saveDefaults(settings: ChatExecutionSettingsV1, expectedRevision: number): Promise<ChatExecutionReadbackV1> {
    this.input.lifetime.throwIfAborted()
    if (this.input.live?.() === false) throw new Error('STALE_GENERATION')
    const result = await this.input.run(this.defaultsSaveAction(), { settings, expectedRevision })
    this.input.lifetime.throwIfAborted()
    if (this.input.live?.() === false) throw new Error('STALE_GENERATION')
    if (result.status !== 'applied' || !result.execution) {
      throw new Error(result.code ?? 'EXECUTION_SETTINGS_UNAVAILABLE')
    }
    return this.project(result.execution, undefined)
  }
  async mount(
    input: {
      target: HTMLElement
      owner: string
      options: ChannelManagerFormOptionsV1
      sessionId?: string
      draft?: ChannelSettingsDraft
      live: () => boolean
      authorize: () => Promise<boolean>
    },
  ) {
    const initial = await this.read(input.sessionId, input.options.signal)
    return mountChannelHostForm({
      target: input.target,
      owner: input.owner,
      options: input.options,
      lifetime: this.input.lifetime,
      live: input.live,
      render: signal =>
        createElement(ChatExecutionForm, {
          initial,
          ...(this.input.defaultsScope === 'channel' ? { defaultsScope: 'channel' as const } : {}),
          ...(input.draft === undefined ? {} : { draft: input.draft }),
          locale: this.input.document.documentElement.lang || 'en',
          signal,
          read: () => this.read(input.sessionId, signal),
          save: async (settings, expectedRevision) => {
            if (!input.live() || signal.aborted) throw new Error('STALE_GENERATION')
            if (!await input.authorize()) throw new Error('PERMISSION_DENIED')
            if (!input.live() || signal.aborted) throw new Error('STALE_GENERATION')
            const result = await this.input.run(
              input.sessionId ? 'execution-settings-set' : this.defaultsSaveAction(),
              {
                settings,
                expectedRevision,
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              },
            )
            if (!input.live() || signal.aborted || this.input.live?.() === false) throw new Error('STALE_GENERATION')
            if (result.status !== 'applied' || !result.execution) {
              throw new Error(result.code ?? 'EXECUTION_SETTINGS_UNAVAILABLE')
            }
            return this.project(result.execution, input.sessionId)
          },
          onResult: result => {
            if (input.live() && !signal.aborted) input.options.onResult?.(result)
          },
        }),
    })
  }
}
