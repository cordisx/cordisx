import { createElement } from 'react'
import type { ChannelManagerFormOptionsV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelManagerActionsApi } from './channel-manager.js'
import { type ChannelTaskFormReadback, ChannelTaskSettingsForm } from './channel-task-settings-form.js'
import { mountChannelHostForm } from './channel-form-mount.js'
import type { ChannelSettingsDraft } from './channel-settings-draft.js'
import type { ChannelTaskConfig, ChannelTaskPatch } from '../launcher/channel-task-config.js'
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}
export class ChannelTaskSettingsWorkflow {
  constructor(
    private readonly input: {
      document: Document
      lifetime: AbortSignal
      live(): boolean
      run: ChannelManagerActionsApi['run']
    },
  ) {}
  private async read(sessionId?: string): Promise<ChannelTaskFormReadback> {
    const [settings, catalog] = await Promise.all([
      this.input.run(sessionId ? 'task-settings' : 'task-config', sessionId ? { sessionId } : {}),
      this.input.run('model-list', {}),
    ])
    this.input.lifetime.throwIfAborted()
    if (!this.input.live() || settings.status !== 'applied' || catalog.status !== 'applied') {
      throw new Error(settings.code ?? 'TASK_SETTINGS_UNAVAILABLE')
    }
    const value = object(settings.task), models = object(catalog.task)
    return {
      revision: Number(value.revision ?? 0),
      ...(sessionId
        ? { settings: object(value.pending ?? value.settings) as ChannelTaskPatch }
        : { config: value.config as ChannelTaskConfig }),
      providers: (Array.isArray(models.providers) ? models.providers : []) as ChannelTaskFormReadback['providers'],
      projects: (Array.isArray(models.projects) ? models.projects : []) as NonNullable<
        ChannelTaskFormReadback['projects']
      >,
      ...(models.projectAvailability === 'unavailable' ? { projectAvailability: 'unavailable' as const } : {}),
    }
  }
  async mount(
    input: {
      target: HTMLElement
      owner: string
      options: ChannelManagerFormOptionsV1
      sessionId?: string
      draft?: ChannelSettingsDraft
      live(): boolean
      authorize(): Promise<boolean>
    },
  ) {
    const initial = await this.read(input.sessionId)
    return mountChannelHostForm({
      ...input,
      lifetime: this.input.lifetime,
      render: signal =>
        createElement(ChannelTaskSettingsForm, {
          initial,
          locale: this.input.document.documentElement.lang || 'en',
          signal,
          ...(input.draft ? { draft: input.draft } : {}),
          read: () => this.read(input.sessionId),
          save: async (value: ChannelTaskConfig | ChannelTaskPatch, expectedRevision: number) => {
            if (!input.live() || signal.aborted || !await input.authorize()) throw new Error('PERMISSION_DENIED')
            if (!input.live() || signal.aborted) throw new Error('STALE_GENERATION')
            const result = await this.input.run(
              input.sessionId ? 'task-settings-set' : 'task-config-set',
              input.sessionId
                ? { sessionId: input.sessionId, settings: value, expectedRevision }
                : { config: value, expectedRevision },
            )
            if (!input.live() || signal.aborted) throw new Error('STALE_GENERATION')
            if (result.status !== 'applied') throw new Error(result.code ?? 'TASK_SETTINGS_UNAVAILABLE')
            return this.read(input.sessionId)
          },
          onResult: result => {
            if (input.live() && !signal.aborted) input.options.onResult?.(result)
          },
        }),
    })
  }
}
