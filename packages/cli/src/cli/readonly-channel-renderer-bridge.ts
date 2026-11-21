import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { openReadonlyHeadlessChannel } from './readonly-headless-channel.js'

type View = NonNullable<Awaited<ReturnType<typeof openReadonlyHeadlessChannel>>>
type Entry = {
  readonly signal: AbortSignal
  readonly view: View
  readonly seen: Set<string>
  readonly onAbort: () => void
}

/**
 * Owner-private bridge for views created by openReadonlyHeadlessChannel.
 * Binding a view is a trusted owner operation, never a renderer request.
 * The caller must fence the whole renderer when its policy, profile, plugin
 * or service authority changes; this bridge does not create that fence.
 */
export class ReadonlyChannelRendererBridge {
  private readonly entries = new Map<string, Entry>()
  private closed = false

  constructor(
    private readonly input: {
      readonly profileId: string
      readonly generation: string
      readonly isCurrent: (context: ManagerRendererChannelContext) => boolean
    },
  ) {}

  private current(context: ManagerRendererChannelContext): boolean {
    try {
      return !this.closed && !context.signal.aborted && context.profileId === this.input.profileId
        && context.ownerGeneration === this.input.generation && this.input.isCurrent(context)
    } catch {
      return false
    }
  }

  bind(context: ManagerRendererChannelContext, view: View): void {
    if (!this.current(context) || this.entries.has(context.rendererId)) {
      view.close()
      throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
    }
    let entry!: Entry
    const onAbort = () => this.retire(context.rendererId, entry)
    entry = { signal: context.signal, view, seen: new Set(), onAbort }
    this.entries.set(context.rendererId, entry)
    context.signal.addEventListener('abort', onAbort, { once: true })
    if (!this.current(context)) {
      this.retire(context.rendererId, entry)
      throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
    }
  }

  /** Owner-only cleanup for a bootstrap that did not reach renderer admission. */
  unbind(context: ManagerRendererChannelContext): void {
    const entry = this.entries.get(context.rendererId)
    if (entry?.signal === context.signal) this.retire(context.rendererId, entry)
  }

  private retire(rendererId: string, entry: Entry): void {
    if (this.entries.get(rendererId) !== entry) return
    this.entries.delete(rendererId)
    entry.signal.removeEventListener('abort', entry.onAbort)
    entry.view.close()
  }

  readonly channel: ManagerRendererChannel = {
    prepare: (payload, context) => {
      const entry = this.entries.get(context.rendererId)
      if (
        !entry || entry.signal !== context.signal || context.admitted !== true || !this.current(context)
        || typeof payload !== 'string' || Buffer.byteLength(payload) > 4096
      ) throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
      const value: unknown = JSON.parse(payload)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('CHANNEL_RENDERER_INVALID')
      }
      const request = value as Record<string, unknown>
      if (
        Object.keys(request).length !== 4
        || Object.keys(request).some(key => !['version', 'token', 'requestId', 'action'].includes(key))
        || request.version !== 1 || request.token !== 'renderer-binding-placeholder' || request.action !== 'snapshot'
        || typeof request.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(request.requestId)
      ) throw new Error('CHANNEL_RENDERER_INVALID')
      const requestId = request.requestId
      return {
        mode: 'read',
        dispatch: async () => {
          if (
            !this.current(context) || this.entries.get(context.rendererId) !== entry
            || entry.seen.has(requestId) || entry.seen.size >= 4096
          ) throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
          entry.seen.add(requestId)
          const result = await entry.view.snapshot()
          if (!this.current(context) || this.entries.get(context.rendererId) !== entry) {
            throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
          }
          return { requestId, ok: true, value: result }
        },
      }
    },
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [rendererId, entry] of this.entries) this.retire(rendererId, entry)
  }
}
