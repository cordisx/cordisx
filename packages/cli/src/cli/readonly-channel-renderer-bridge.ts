import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { openReadonlyHeadlessChannel } from './readonly-headless-channel.js'

type View = NonNullable<Awaited<ReturnType<typeof openReadonlyHeadlessChannel>>>
type Entry = {
  readonly context: ManagerRendererChannelContext
  readonly signal: AbortSignal
  view: View
  readonly seen: Set<string>
  readonly reads: Set<Promise<unknown>>
  readonly onAbort: () => void
}
type Suspension = { readonly entries: ReadonlyMap<string, Entry> }
type ViewReservation = { isCurrent(): boolean; replace(view: View): boolean }

/**
 * Owner-private bridge for views created by openReadonlyHeadlessChannel.
 * Binding a view is a trusted owner operation, never a renderer request.
 * The caller must fence the whole renderer when its policy, profile, plugin
 * or service authority changes; this bridge does not create that fence.
 */
export class ReadonlyChannelRendererBridge {
  private readonly entries = new Map<string, Entry>()
  private suspended: Suspension | undefined
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
    if (!this.current(context) || this.suspended || this.entries.has(context.rendererId)) {
      view.close()
      throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
    }
    let entry!: Entry
    const onAbort = () => this.retire(context.rendererId, entry)
    entry = { context, signal: context.signal, view, seen: new Set(), reads: new Set(), onAbort }
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

  /** Stop and drain exactly the owner-supplied set before changing the service. */
  async suspendAll(rendererIds: readonly string[], timeoutMs = 15_000): Promise<{
    isCurrent(): boolean
    forRenderer(rendererId: string): ViewReservation
    release(): boolean
    fence(): void
  }> {
    const entries = new Map(rendererIds.map(rendererId => [rendererId, this.entries.get(rendererId)] as const))
    if (
      this.closed || this.suspended || rendererIds.length === 0 || entries.size !== rendererIds.length
      || this.entries.size !== entries.size
      || [...entries.values()].some(entry => !entry || !this.current(entry.context))
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000
    ) throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
    const suspension: Suspension = { entries: entries as Map<string, Entry> }
    this.suspended = suspension
    const current = () =>
      !this.closed && this.suspended === suspension && this.entries.size === suspension.entries.size
      && [...suspension.entries].every(([rendererId, entry]) =>
        this.entries.get(rendererId) === entry && this.current(entry.context)
      )
    const fence = () => {
      if (this.suspended !== suspension) return
      for (const [rendererId, entry] of suspension.entries) this.retire(rendererId, entry)
      this.suspended = undefined
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let drained: boolean
    try {
      drained = await Promise.race([
        Promise.allSettled([...suspension.entries.values()].flatMap(entry => [...entry.reads])).then(() => true),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (!drained || !current()) {
      fence()
      throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
    }
    const replaced = new Set<string>()
    return {
      isCurrent: current,
      forRenderer: rendererId => {
        const entry = suspension.entries.get(rendererId)
        if (!entry) throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
        return {
          isCurrent: current,
          replace: view => {
            if (!current() || replaced.has(rendererId) || view === entry.view) {
              if (view !== entry.view) view.close()
              return false
            }
            entry.view.close()
            entry.view = view
            replaced.add(rendererId)
            return true
          },
        }
      },
      release: () => {
        if (!current()) {
          fence()
          return false
        }
        this.suspended = undefined
        return true
      },
      fence,
    }
  }

  /** One-renderer compatibility; an unaccounted view still rejects the handoff. */
  async suspend(rendererId: string, timeoutMs = 15_000): Promise<
    ViewReservation & {
      release(): boolean
      fence(): void
    }
  > {
    const fleet = await this.suspendAll([rendererId], timeoutMs)
    return { ...fleet.forRenderer(rendererId), release: fleet.release, fence: fleet.fence }
  }

  readonly channel: ManagerRendererChannel = {
    prepare: (payload, context) => {
      const entry = this.entries.get(context.rendererId)
      if (
        !entry || this.suspended || entry.signal !== context.signal || context.admitted !== true
        || !this.current(context)
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
            this.suspended || !this.current(context) || this.entries.get(context.rendererId) !== entry
            || entry.seen.has(requestId) || entry.seen.size >= 4096
          ) throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
          entry.seen.add(requestId)
          const read = entry.view.snapshot()
          entry.reads.add(read)
          try {
            const result = await read
            if (!this.current(context) || this.entries.get(context.rendererId) !== entry) {
              throw new Error('CHANNEL_RENDERER_UNAVAILABLE')
            }
            return { requestId, ok: true, value: result }
          } finally {
            entry.reads.delete(read)
          }
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
