import type {
  DialogActionV1,
  DialogChromeV1,
  DialogCloseReasonV1,
  DialogConfirmOptionsV1,
  DialogFormOptionsV1,
  DialogHandleV1,
  DialogMountV1,
  DialogOpenOptionsV1,
  DialogOptionsV1,
  DialogResultV1,
  DialogsV1,
} from '../../dialog-contracts.js'

export interface DialogOwner {
  readonly key: string
  readonly name: () => string
  readonly active: () => boolean
  readonly report: (kind: string) => void
}
export interface DialogEntry {
  readonly id: number
  readonly owner: DialogOwner
  readonly options: DialogOptionsV1
  chrome: DialogChromeV1
  readonly abort: AbortController
  readonly handle: DialogHandleV1
  readonly resolve: (result: DialogResultV1) => void
  readonly mount?: DialogMountV1
  readonly props: Readonly<Record<string, unknown>>
  readonly parent?: DialogEntry
  readonly form?: DialogFormOptionsV1
  closing: boolean
  busy: string | undefined
  closed: boolean
  revision: number
  focus?: () => void
  onDispose?: () => void
}
export interface DialogBinding {
  readonly api: DialogsV1
  readonly owner: DialogOwner
  readonly openBody: (options: DialogOptionsV1, mount: DialogMountV1) => DialogHandleV1
  disposeBody(handle: DialogHandleV1): void
  dispose(): void
}
export const dialogHandleOwners = new WeakMap<DialogHandleV1, DialogOwner>()
export const dialogBindings = new WeakMap<DialogsV1, DialogBinding>()
const text = (value: unknown, label: string, maximum = 240) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new TypeError(`Invalid dialog ${label}`)
  }
}
export function validateChrome(chrome: DialogChromeV1) {
  text(chrome.title, 'title')
  if (
    chrome.footer !== undefined
    && (typeof chrome.footer !== 'object' || chrome.footer === null || '$$typeof' in chrome.footer
      || Object.keys(chrome.footer).some(key => !['status', 'secondaryActions', 'primaryAction'].includes(key)))
  ) throw new TypeError('Invalid dialog footer')
  if (chrome.headerActions !== undefined && !Array.isArray(chrome.headerActions)) {
    throw new TypeError('Invalid header actions')
  }
  if (chrome.footer?.secondaryActions !== undefined && !Array.isArray(chrome.footer.secondaryActions)) {
    throw new TypeError('Invalid footer actions')
  }
  if (chrome.description !== undefined) text(chrome.description, 'description', 2000)
  if (chrome.size !== undefined && !['small', 'medium', 'large'].includes(chrome.size)) {
    throw new TypeError('Invalid dialog size')
  }
  if (chrome.bodyLayout !== undefined && !['scroll', 'fill'].includes(chrome.bodyLayout)) {
    throw new TypeError('Invalid body layout')
  }
  if ((chrome.headerActions?.length ?? 0) > 8 || (chrome.footer?.secondaryActions?.length ?? 0) > 3) {
    throw new TypeError('Too many dialog actions')
  }
  if (chrome.footer?.status !== undefined) text(chrome.footer.status, 'status')
  const ids = new Set<string>()
  for (
    const action of [
      ...chrome.headerActions ?? [],
      ...chrome.footer?.secondaryActions ?? [],
      ...chrome.footer?.primaryAction ? [chrome.footer.primaryAction] : [],
    ]
  ) {
    text(action.id, 'action id', 80)
    text(action.label, 'action label', 80)
    if (ids.has(action.id) || typeof action.onAction !== 'function') throw new TypeError('Invalid dialog action')
    if (action.icon !== undefined && !['share', 'copy', 'refresh', 'help', 'settings'].includes(action.icon)) {
      throw new TypeError('Invalid dialog icon')
    }
    if (action.tone !== undefined && !['neutral', 'danger'].includes(action.tone)) {
      throw new TypeError('Invalid action tone')
    }
    ids.add(action.id)
  }
}
function snapshotChrome(input: DialogChromeV1): DialogChromeV1 {
  const action = (value: DialogActionV1): DialogActionV1 => Object.freeze({ ...value })
  const copy: DialogChromeV1 = {
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.size === undefined ? {} : { size: input.size }),
    ...(input.bodyLayout === undefined ? {} : { bodyLayout: input.bodyLayout }),
    ...(input.closeOnBackdrop === undefined ? {} : { closeOnBackdrop: input.closeOnBackdrop }),
    ...(input.beforeClose === undefined ? {} : { beforeClose: input.beforeClose }),
    ...(input.headerActions === undefined ? {} : { headerActions: Object.freeze(input.headerActions.map(action)) }),
    ...(input.footer === undefined ? {} : {
      footer: Object.freeze({
        ...(input.footer.status === undefined ? {} : { status: input.footer.status }),
        ...(input.footer.secondaryActions === undefined
          ? {}
          : { secondaryActions: Object.freeze(input.footer.secondaryActions.map(action)) }),
        ...(input.footer.primaryAction === undefined ? {} : { primaryAction: action(input.footer.primaryAction) }),
      }),
    }),
  }
  validateChrome(copy)
  return Object.freeze(copy)
}

const inert = (status: 'disposed' | 'unavailable' | 'queue-full'): DialogHandleV1 => {
  const controller = new AbortController()
  controller.abort()
  return { result: Promise.resolve({ status }), signal: controller.signal, close: async () => false, update: () => {} }
}
/** One window queue. Normal requests never preempt the current modal. */
export class DialogCenter {
  private entries: DialogEntry[] = []
  private listeners = new Set<() => void>()
  private nextId = 0
  private version = 0
  private disposed = false
  private bindings = new Set<DialogBinding>()
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.version
  changed() {
    this.version++
    for (const listener of this.listeners) listener()
  }
  visible(): DialogEntry[] {
    const first = this.entries.find(entry => !entry.parent)
    return first ? [first, ...this.entries.filter(entry => entry.parent === first)] : []
  }
  all() {
    return [...this.entries]
  }
  bind(owner: DialogOwner): DialogBinding {
    const views = new Map<string, DialogMountV1>()
    let retired = false
    const live = () => !retired && !this.disposed && owner.active()
    const open = (
      options: DialogOptionsV1,
      mount?: DialogMountV1,
      props: Readonly<Record<string, unknown>> = {},
      parent?: DialogEntry,
      form?: DialogFormOptionsV1,
    ): DialogHandleV1 => {
      validateChrome(options)
      const chrome = snapshotChrome(options)
      text(options.kind, 'kind', 100)
      if (options.instanceKey !== undefined) text(options.instanceKey, 'instance key', 200)
      if (!live()) return inert('disposed')
      const existing = options.instanceKey === undefined
        ? undefined
        : this.entries.find(entry =>
          entry.owner === owner && entry.options.kind === options.kind
          && entry.options.instanceKey === options.instanceKey
        )
      if (existing) {
        existing.focus?.()
        return existing.handle
      }
      if (this.entries.length >= 20 || this.entries.filter(entry => entry.owner === owner).length >= 5) {
        return inert('queue-full')
      }
      const abort = new AbortController()
      let resolve!: (result: DialogResultV1) => void
      const result = new Promise<DialogResultV1>(done => {
        resolve = done
      })
      const entry: DialogEntry = {
        id: ++this.nextId,
        owner,
        options: Object.freeze({
          ...chrome,
          kind: options.kind,
          ...(options.instanceKey === undefined ? {} : { instanceKey: options.instanceKey }),
        }),
        chrome,
        abort,
        resolve,
        props,
        ...(mount ? { mount } : {}),
        ...(parent ? { parent } : {}),
        ...(form ? { form } : {}),
        closing: false,
        busy: undefined,
        closed: false,
        revision: 0,
        handle: {
          result,
          signal: abort.signal,
          close: reason => this.close(entry, reason ?? 'programmatic'),
          update: chrome => {
            validateChrome(chrome)
            if (!entry.closed && live()) {
              entry.chrome = snapshotChrome(chrome)
              entry.revision++
              this.changed()
            }
          },
        },
      }
      dialogHandleOwners.set(entry.handle, owner)
      this.entries.push(entry)
      this.changed()
      return entry.handle
    }
    const api: DialogsV1 = Object.freeze({
      contract: 'cordisx.dialogs/v1',
      register: (id: string, mount: DialogMountV1) => {
        text(id, 'view id', 100)
        if (!live()) throw new Error('Dialog owner is retired')
        if (views.has(id) || typeof mount !== 'function') throw new TypeError('Invalid or duplicate dialog view')
        const ownedMount: DialogMountV1 = context => mount(context)
        views.set(id, ownedMount)
        return () => {
          if (views.get(id) !== ownedMount) return
          views.delete(id)
          for (const entry of [...this.entries]) {
            if (entry.owner === owner && entry.mount === ownedMount) this.finish(entry, { status: 'disposed' })
          }
        }
      },
      open: (options: DialogOpenOptionsV1) => {
        if (!live()) return inert('disposed')
        const mount = views.get(options.content.id)
        if (!mount) return inert('unavailable')
        return open(options, mount, options.content.props)
      },
      confirm: (options: DialogConfirmOptionsV1) => {
        const parent = options.parent
          ? this.entries.find(entry => entry.handle === options.parent && entry.owner === owner)
          : undefined
        if (options.parent && (!parent || parent.parent || this.visible().at(-1) !== parent)) {
          return Promise.resolve({ status: 'unavailable' as const })
        }
        let handle: DialogHandleV1
        handle = open(
          {
            ...options,
            footer: {
              primaryAction: {
                id: 'confirm',
                label: options.confirmLabel,
                ...(options.tone ? { tone: options.tone } : {}),
                closeOnSuccess: true,
                onAction: options.run,
              },
              secondaryActions: [{
                id: 'cancel',
                label: this.copy.cancel,
                onAction: async () => {
                  await handle.close('cancel')
                },
              }],
            },
          },
          undefined,
          {},
          parent,
        )
        return handle.result
      },
      form: (options: DialogFormOptionsV1) => {
        if (!options.fields.length || options.fields.length > 30 || typeof options.submit !== 'function') {
          throw new TypeError('Invalid dialog form')
        }
        const ids = new Set<string>()
        for (const field of options.fields) {
          text(field.id, 'field id', 80)
          text(field.label, 'field label')
          if (ids.has(field.id) || !['string', 'number', 'boolean'].includes(field.type)) {
            throw new TypeError('Invalid dialog field')
          }
          if (field.initialValue !== undefined && typeof field.initialValue !== field.type) {
            throw new TypeError('Invalid initial field value')
          }
          if (
            field.min !== undefined && !Number.isFinite(field.min)
            || field.max !== undefined && !Number.isFinite(field.max)
            || field.min !== undefined && field.max !== undefined && field.min > field.max
          ) throw new TypeError('Invalid field bounds')
          ids.add(field.id)
        }
        return open(options, undefined, {}, undefined, options).result
      },
    })
    const binding: DialogBinding = {
      api,
      owner,
      openBody: (options, mount) => open(options, mount),
      disposeBody: handle => {
        const entry = this.entries.find(item => item.handle === handle && item.owner === owner)
        if (entry) this.finish(entry, { status: 'disposed' })
      },
      dispose: () => {
        if (retired) return
        retired = true
        views.clear()
        for (const entry of [...this.entries]) if (entry.owner === owner) this.finish(entry, { status: 'disposed' })
        this.bindings.delete(binding)
      },
    }
    dialogBindings.set(api, binding)
    this.bindings.add(binding)
    return binding
  }
  constructor(
    readonly copy = {
      cancel: 'Cancel',
      close: 'Close',
      more: 'More',
      loading: 'Loading…',
      failed: 'Unable to display this content.',
      retry: 'Retry',
    },
  ) {}
  async close(entry: DialogEntry, reason: DialogCloseReasonV1) {
    if (entry.closed || entry.closing || this.entries.some(child => child.parent === entry)) return false
    if (!entry.owner.active()) {
      this.finish(entry, { status: 'disposed' })
      return true
    }
    // Closing remains available during a task; its signal is aborted on actual dismissal.
    entry.closing = true
    this.changed()
    try {
      if (entry.chrome.beforeClose && !await entry.chrome.beforeClose(reason, entry.abort.signal)) return false
      if (entry.closed) return false
      this.finish(entry, { status: 'closed', reason })
      return true
    } catch {
      if (!entry.closed) entry.owner.report(entry.options.kind)
      return false
    } finally {
      if (!entry.closed) {
        entry.closing = false
        this.changed()
      }
    }
  }
  async run(entry: DialogEntry, action: DialogActionV1) {
    if (
      entry.closed || entry.closing || entry.busy || action.disabled || action.pending || !entry.owner.active()
      || this.visible().at(-1) !== entry
    ) return
    entry.busy = action.id
    this.changed()
    try {
      await action.onAction(entry.abort.signal)
      if (!entry.closed && action.closeOnSuccess) this.finish(entry, { status: 'completed', actionId: action.id })
    } catch {
      if (!entry.closed) entry.owner.report(entry.options.kind)
    } finally {
      if (!entry.closed) {
        entry.busy = undefined
        this.changed()
      }
    }
  }
  finish(entry: DialogEntry, result: DialogResultV1) {
    if (entry.closed) return
    entry.closed = true
    for (const child of [...this.entries]) if (child.parent === entry) this.finish(child, { status: 'disposed' })
    entry.abort.abort()
    entry.onDispose?.()
    entry.resolve(result)
    this.entries = this.entries.filter(item => item !== entry)
    this.changed()
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const binding of [...this.bindings]) binding.dispose()
    this.listeners.clear()
  }
}
