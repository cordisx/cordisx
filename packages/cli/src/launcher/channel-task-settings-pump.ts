import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationStore, ChannelTaskRequest } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import type { ChannelTaskPatch } from './channel-task-config.js'
import { channelTaskIntentObserved, channelTaskSelectionMatches } from './channel-task-selection.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
/** Reserve exact persisted intent before native effects; uncertain acknowledgements are never retried. */
export class ChannelTaskSettingsPump {
  private pumping = false
  private offset = 0
  constructor(
    private readonly input: {
      store: ChannelConversationStore
      native(): ChannelNativeSessions | undefined
      isBound(threadId: string): boolean
      bound(event: ChannelEventRef, threadId: string): boolean
      allowed(event: ChannelEventRef, patch: ChannelTaskPatch, selection: ChannelTaskPatch): boolean
      validate(patch: ChannelTaskPatch, threadId?: string): Promise<ChannelTaskPatch>
      card(request: ChannelTaskRequest): Promise<void>
    },
  ) {}
  async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      const expired: string[] = []
      await this.input.store.mutate(state => {
        for (const request of Object.values(state.taskRequests)) {
          if (!['pending', 'queued'].includes(request.state) || request.expiresAt > Date.now()) continue
          request.state = 'expired'
          expired.push(request.id)
          const setting = state.taskSettings[request.threadId]
          if (setting && setting.revision === request.expectedRevision + 1 && setting.application === 'saved') {
            delete setting.pending
            delete setting.pendingPatch
            setting.application = 'applied'
            setting.code = 'TASK_REQUEST_EXPIRED'
          }
        }
        // Keep recent receipts, but bound inactive approval data independently of binding cardinality.
        const terminal = Object.values(state.taskRequests).filter(request =>
          !['pending', 'queued', 'applying', 'submitted'].includes(request.state)
        )
          .sort((a, b) => b.createdAt - a.createdAt)
        for (const request of terminal.slice(2_000)) delete state.taskRequests[request.id]
      })
      for (const id of expired) {
        const request = this.input.store.snapshot().taskRequests[id]
        if (request) await this.input.card(request)
      }
      const native = this.input.native()
      if (!native) return
      const settings = Object.entries(this.input.store.snapshot().taskSettings).filter(([, record]) =>
        ['saved', 'submitted'].includes(record.application)
      )
      const start = settings.length ? this.offset % settings.length : 0
      const selected = [...settings.slice(start), ...settings.slice(0, start)].slice(0, 8)
      this.offset = start + selected.length
      await Promise.all(selected.map(async ([threadId, record]) => {
        const request = Object.values(this.input.store.snapshot().taskRequests).find(item =>
          item.threadId === threadId
          && ['queued', 'submitted'].includes(item.state) && item.expectedRevision + 1 === record.revision
        )
        if (record.application === 'submitted') {
          try {
            const actual = await native.taskSelection(threadId)
            if (!record.requested) return
            if (channelTaskIntentObserved(record.requested, actual)) {
              await this.finish(threadId, record.revision, actual, 'applied', request)
            } else if (actual.providerId !== record.requested.providerId || actual.model !== record.requested.model) {
              await this.finish(threadId, record.revision, actual, 'unknown', request, 'NATIVE_SELECTION_CHANGED')
            }
          } catch { /* No native readback means no claim of application. */ }
          return
        }
        if (!record.pending || !record.pendingPatch || !record.baseSelection) return
        if (
          !this.input.isBound(threadId)
          || request && (!request.approvedBy || !this.input.bound(request.source, threadId)
              || !this.input.allowed(request.approvedBy, request.patch, request.selection))
        ) {
          await this.finish(
            threadId,
            record.revision,
            record.settings,
            'applied',
            request,
            'MODEL_CHANGE_PERMISSION_DENIED',
            'denied',
          )
          return
        }
        try {
          if (!await native.idle(threadId)) return
        } catch {
          return
        }
        let actual: ChannelTaskPatch
        try {
          actual = await native.taskSelection(threadId)
          await this.input.validate(record.pending, threadId)
        } catch {
          await this.finish(
            threadId,
            record.revision,
            record.settings,
            'applied',
            request,
            'SELECTION_UNAVAILABLE',
            'denied',
          )
          return
        }
        if (!channelTaskSelectionMatches(actual, record.baseSelection)) {
          await this.finish(threadId, record.revision, actual, 'applied', request, 'REVISION_CONFLICT', 'denied')
          return
        }
        let claimed = false
        await this.input.store.mutate(state => {
          const latest = state.taskSettings[threadId]
          if (
            !latest || latest.revision !== record.revision || latest.application !== 'saved'
            || !channelTaskSelectionMatches(latest.pending ?? {}, record.pending!)
          ) return
          if (request) {
            const current = state.taskRequests[request.id]
            if (current?.state !== 'queued' || !current.approvedBy || current.expiresAt <= Date.now()) return
            if (
              !this.input.bound(current.source, threadId)
              || !this.input.allowed(current.approvedBy, current.patch, current.selection)
            ) return
            current.state = 'applying'
          }
          latest.application = 'applying'
          latest.requested = record.pending!
          claimed = true
        })
        if (!claimed) return
        const revalidate = async (applied: ChannelTaskPatch = {}) => {
          await this.input.validate(record.pending!, threadId)
          const observed = await native.taskSelection(threadId)
          const state = this.input.store.snapshot(), latest = state.taskSettings[threadId]
          if (
            !latest || latest.revision !== record.revision || latest.application !== 'applying'
            || !this.input.isBound(threadId)
          ) return false
          if (request) {
            const current = state.taskRequests[request.id]
            if (
              current?.state !== 'applying' || !current.approvedBy || current.expiresAt <= Date.now()
              || !this.input.bound(current.source, threadId)
              || !this.input.allowed(current.approvedBy, current.patch, current.selection)
            ) return false
          }
          return channelTaskSelectionMatches(observed, { ...record.baseSelection!, ...applied })
        }
        let result: Record<string, unknown>
        try {
          result = object(await native.applyTaskSelection(threadId, record.pending, revalidate))
        } catch {
          result = { status: 'reconciliation-required' }
        }
        if (
          result.status === 'rejected' && (['selection-busy', 'thread-not-idle'].includes(String(result.reason))
            || ['THREAD_NOT_IDLE', 'CHAT_SETTINGS_BUSY'].includes(String(result.code)))
        ) {
          await this.input.store.mutate(state => {
            const latest = state.taskSettings[threadId]
            if (latest?.revision !== record.revision || latest.application !== 'applying') return
            latest.application = 'saved'
            if (request && state.taskRequests[request.id]?.state === 'applying') {
              state.taskRequests[request.id]!.state = 'queued'
            }
          })
          return
        }
        if (result.status === 'selected') {
          const application = result.application === 'saved' ? 'submitted' : 'applied'
          await this.finish(threadId, record.revision, record.pending, application, request)
        } else {await this.finish(
            threadId,
            record.revision,
            actual,
            result.status === 'rejected' ? 'applied' : 'unknown',
            request,
            result.status === 'rejected'
              ? result.reason === 'provider-switch-unavailable'
                ? 'NATIVE_PROVIDER_SWITCH_UNAVAILABLE'
                : 'NATIVE_SELECTION_REJECTED'
              : 'NATIVE_EFFECT_UNCERTAIN',
            result.status === 'rejected' ? 'denied' : 'unknown',
          )}
      }))
    } finally {
      this.pumping = false
    }
  }
  private async finish(
    threadId: string,
    revision: number,
    settings: ChannelTaskPatch,
    application: 'applied' | 'submitted' | 'unknown',
    request?: ChannelTaskRequest,
    code?: string,
    requestState?: ChannelTaskRequest['state'],
  ) {
    let updated = false
    await this.input.store.mutate(state => {
      const record = state.taskSettings[threadId]
      if (!record || record.revision !== revision) return
      record.settings = settings
      record.application = application
      delete record.pending
      delete record.pendingPatch
      if (code) record.code = code
      else delete record.code
      if (request && state.taskRequests[request.id]) {
        state.taskRequests[request.id]!.state = requestState ?? application
        if (code) state.taskRequests[request.id]!.code = code
      }
      updated = true
    })
    const latest = request && this.input.store.snapshot().taskRequests[request.id]
    if (updated && latest) await this.input.card(latest)
  }
}
