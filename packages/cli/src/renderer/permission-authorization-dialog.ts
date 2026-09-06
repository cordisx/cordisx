import {
  type PermissionAuthorizationDialogResult,
  type PermissionAuthorizationProjectionInput,
  PermissionAuthorizationViewModel,
} from '../permission-authorization-view-model.js'
import type { CordisXPermissionAuthorizationBindingV2 } from '../permission-contracts.js'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { PermissionAuthorizationView } from './host-ui/PermissionAuthorizationView.js'
import { HostThemeProjection } from './host-theme.js'

export interface PermissionAuthorizationDialogRequest {
  /** Returns a fresh locale projection without changing the underlying request. */
  readonly project: () => PermissionAuthorizationProjectionInput
  readonly subscribeLocale?: (listener: () => void) => () => void
}

interface ActiveDialog {
  readonly requestKey: string
  readonly finish: (result: PermissionAuthorizationDialogResult) => void
}

interface QueuedDialog {
  readonly requestKey: string
  readonly viewModel: PermissionAuthorizationViewModel
  readonly request: PermissionAuthorizationDialogRequest
  readonly resolve: (result: PermissionAuthorizationDialogResult) => void
  readonly reject: (reason?: unknown) => void
}

function dialogRequestKey(planId: string, binding: CordisXPermissionAuthorizationBindingV2): string {
  return [
    planId,
    binding.operationId,
    binding.runtimeGeneration,
    binding.moduleGeneration ?? '',
    binding.requestId ?? '',
  ].join('\u0000')
}

function focusable(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), summary, [tabindex]',
  )].filter(node => node.tabIndex >= 0 && !node.hidden && node.closest('[hidden]') === null)
}

/** One queued Host-owned surface shared by install/enable and runtime reviews. */
export class BrowserPermissionAuthorizationDialog {
  private readonly theme: HostThemeProjection
  private readonly ownsTheme: boolean
  private readonly queue: QueuedDialog[] = []
  private active: ActiveDialog | undefined
  private disposed = false

  constructor(private readonly document: Document, theme?: HostThemeProjection) {
    this.theme = theme ?? new HostThemeProjection(document)
    this.ownsTheme = theme === undefined
  }

  show(
    viewModel: PermissionAuthorizationViewModel,
    request: PermissionAuthorizationDialogRequest,
  ): Promise<PermissionAuthorizationDialogResult> {
    if (this.disposed) return Promise.resolve(Object.freeze({ status: 'cancelled' }))
    return new Promise((resolve, reject) => {
      this.queue.push({
        requestKey: dialogRequestKey(viewModel.plan.planId, viewModel.plan.binding),
        viewModel,
        request,
        resolve,
        reject,
      })
      this.pump()
    })
  }

  /** Cancels only the exact Host plan/binding, whether active or still queued. */
  cancel(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void {
    const requestKey = dialogRequestKey(planId, binding)
    const cancelled = Object.freeze({ status: 'cancelled' as const })
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index]
      if (queued?.requestKey !== requestKey) continue
      this.queue.splice(index, 1)
      queued.resolve(cancelled)
    }
    if (this.active?.requestKey === requestKey) this.active.finish(cancelled)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const cancelled = Object.freeze({ status: 'cancelled' as const })
    for (const queued of this.queue.splice(0)) queued.resolve(cancelled)
    this.active?.finish(Object.freeze({ status: 'cancelled' }))
    if (this.ownsTheme) this.theme.dispose()
  }

  private pump(): void {
    if (this.disposed || this.active !== undefined) return
    const queued = this.queue.shift()
    if (queued === undefined) return
    void this.open(queued.viewModel, queued.request, queued.requestKey).then(
      queued.resolve,
      queued.reject,
    ).finally(() => this.pump())
  }

  private open(
    viewModel: PermissionAuthorizationViewModel,
    request: PermissionAuthorizationDialogRequest,
    requestKey: string,
  ): Promise<PermissionAuthorizationDialogResult> {
    if (this.disposed) return Promise.resolve(Object.freeze({ status: 'cancelled' }))
    return new Promise((resolve, reject) => {
      const HTMLElementConstructor = this.document.defaultView?.HTMLElement
      const previousFocus = HTMLElementConstructor !== undefined
          && this.document.activeElement instanceof HTMLElementConstructor
        ? this.document.activeElement as HTMLElement
        : undefined
      const initial = viewModel.project(request.project())
      const overlay = this.document.createElement('div')
      overlay.className = 'cxp-overlay cxh-tdesign-root'
      overlay.dataset.permissionAuthorization = viewModel.plan.planId
      overlay.style.setProperty('-webkit-app-region', 'no-drag')
      const detachTheme = this.theme.attach(overlay)
      this.document.body.append(overlay)
      const root = createRoot(overlay, {
        onUncaughtError: error => queueMicrotask(() => fail(error)),
      })
      let finished = false
      let unsubscribeLocale: (() => void) | undefined
      const cleanup = (): boolean => {
        if (finished) return false
        finished = true
        unsubscribeLocale?.()
        root.unmount()
        detachTheme()
        overlay.remove()
        if (this.active?.finish === finish) this.active = undefined
        if (previousFocus?.isConnected) previousFocus.focus()
        return true
      }
      const finish = (result: PermissionAuthorizationDialogResult): void => {
        if (cleanup()) resolve(result)
      }
      const fail = (error: unknown): void => {
        if (cleanup()) reject(error)
      }
      const render = (): void => {
        if (finished) return
        try {
          const projection = viewModel.project(request.project())
          if (initial.items.length !== projection.items.length) {
            throw new Error('locale projection changed the permission plan shape')
          }
          for (const [index, item] of projection.items.entries()) {
            const previous = initial.items[index]
            if (previous?.capability !== item.capability) {
              throw new Error('locale projection changed the permission plan identity')
            }
            if (
              previous.authorizationOptions.map(option => option.value).join()
                !== item.authorizationOptions.map(option => option.value).join()
            ) {
              throw new Error('locale projection changed allowed permission decisions')
            }
          }
          flushSync(() =>
            root.render(createElement(PermissionAuthorizationView, {
              projection,
              viewModel,
              overlay,
              onSelectionChange: render,
              finish,
            }))
          )
        } catch (error) {
          fail(error)
        }
      }
      this.active = { requestKey, finish }
      overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          finish(viewModel.cancel())
          return
        }
        if (event.key !== 'Tab') return
        const candidates = focusable(overlay)
        const first = candidates[0]
        const last = candidates.at(-1)
        if (first === undefined || last === undefined) return
        if (event.shiftKey && this.document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && this.document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      })
      try {
        render()
        if (finished) return
        unsubscribeLocale = request.subscribeLocale?.(render)
        // A subscription may immediately publish its current locale.
        if (finished) {
          unsubscribeLocale?.()
          return
        }
        const selected = overlay.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
        ;(selected ?? overlay.querySelector<HTMLElement>('[data-permission-action="confirm"]'))?.focus()
      } catch (error) {
        fail(error)
      }
    })
  }
}
