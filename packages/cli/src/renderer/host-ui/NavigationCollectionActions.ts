import { createHostSurfaceIcon } from '../icons.js'

export interface HostNavigationCollectionAction {
  readonly id: string
  readonly label: string
  readonly ariaLabel: string
  readonly icon?: string
  readonly placement: 'direct' | 'overflow'
  readonly tone: 'neutral' | 'danger'
  readonly pressed: boolean
  readonly disabled: boolean
  readonly disabledReason?: string
  readonly success: string
  readonly failure: string
  readonly confirmation?: Readonly<{
    title: string
    description: string
    confirmLabel: string
  }>
  invoke(): Promise<unknown>
}

function hostCopy(document: Document): Readonly<{ more: string; cancel: string }> {
  const chinese = document.documentElement.lang.toLowerCase().startsWith('zh')
  return chinese ? { more: '更多操作', cancel: '取消' } : { more: 'More actions', cancel: 'Cancel' }
}

function focusable(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
}

interface MountOwner {
  active: boolean
  readonly cleanups: Set<() => void>
}

function own(owner: MountOwner, cleanup: () => void): () => void {
  if (!owner.active) {
    cleanup()
    return () => {}
  }
  owner.cleanups.add(cleanup)
  return () => { owner.cleanups.delete(cleanup) }
}

function disposeOwner(owner: MountOwner): void {
  if (!owner.active) return
  owner.active = false
  for (const cleanup of [...owner.cleanups]) cleanup()
  owner.cleanups.clear()
}

function showFeedback(document: Document, owner: MountOwner, message: string, failed: boolean): void {
  if (!owner.active) return
  const toast = document.createElement('div')
  toast.className = 'cordisx-navigation-feedback'
  toast.dataset.tone = failed ? 'danger' : 'neutral'
  toast.setAttribute('role', failed ? 'alert' : 'status')
  toast.setAttribute('aria-live', failed ? 'assertive' : 'polite')
  toast.textContent = message
  document.body.append(toast)
  const view = document.defaultView
  let timer: number | undefined
  let release = (): void => {}
  const remove = (): void => {
    if (timer !== undefined) view?.clearTimeout(timer)
    timer = undefined
    toast.remove()
    release()
  }
  release = own(owner, remove)
  timer = view?.setTimeout(remove, 2200)
}

function confirmAction(
  document: Document,
  action: HostNavigationCollectionAction,
  returnFocus: HTMLElement,
  owner: MountOwner,
): Promise<boolean> {
  if (!owner.active) return Promise.resolve(false)
  const confirmation = action.confirmation
  if (confirmation === undefined) return Promise.resolve(true)
  const copy = hostCopy(document)
  return new Promise(resolve => {
    const backdrop = document.createElement('div')
    backdrop.className = 'cordisx-navigation-confirm-backdrop'
    const dialog = document.createElement('div')
    dialog.className = 'cordisx-navigation-confirm'
    dialog.setAttribute('role', 'alertdialog')
    dialog.setAttribute('aria-modal', 'true')
    const title = document.createElement('div')
    title.className = 'cordisx-navigation-confirm-title'
    title.id = `cordisx-confirm-${action.id}-${Date.now()}`
    title.textContent = confirmation.title
    dialog.setAttribute('aria-labelledby', title.id)
    const description = document.createElement('div')
    description.className = 'cordisx-navigation-confirm-description'
    description.id = `${title.id}-description`
    description.textContent = confirmation.description
    dialog.setAttribute('aria-describedby', description.id)
    const footer = document.createElement('div')
    footer.className = 'cordisx-navigation-confirm-footer'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'cordisx-navigation-confirm-button'
    cancel.textContent = copy.cancel
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'cordisx-navigation-confirm-button cordisx-navigation-confirm-danger'
    confirm.textContent = confirmation.confirmLabel
    footer.append(cancel, confirm)
    dialog.append(title, description, footer)
    backdrop.append(dialog)
    let settled = false
    let release = (): void => {}
    const settle = (accepted: boolean, restoreFocus = true): void => {
      if (settled) return
      settled = true
      cancel.removeEventListener('click', onCancel)
      confirm.removeEventListener('click', onConfirm)
      backdrop.removeEventListener('pointerdown', onBackdrop)
      backdrop.remove()
      document.removeEventListener('keydown', onKeyDown, true)
      release()
      if (restoreFocus && owner.active && returnFocus.isConnected) returnFocus.focus()
      resolve(accepted)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        settle(false)
      } else if (event.key === 'Tab') {
        const buttons = focusable(dialog)
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.shiftKey
          ? (current <= 0 ? buttons.length - 1 : current - 1)
          : (current >= buttons.length - 1 ? 0 : current + 1)
        event.preventDefault()
        buttons[next]?.focus()
      }
    }
    const onCancel = (): void => settle(false)
    const onConfirm = (): void => settle(true)
    const onBackdrop = (event: PointerEvent): void => {
      if (event.target === backdrop) settle(false)
    }
    cancel.addEventListener('click', onCancel)
    confirm.addEventListener('click', onConfirm)
    backdrop.addEventListener('pointerdown', onBackdrop)
    document.addEventListener('keydown', onKeyDown, true)
    release = own(owner, () => settle(false, false))
    document.body.append(backdrop)
    cancel.focus()
  })
}

async function invoke(
  document: Document,
  action: HostNavigationCollectionAction,
  returnFocus: HTMLElement,
  owner: MountOwner,
): Promise<void> {
  if (!owner.active || !await confirmAction(document, action, returnFocus, owner) || !owner.active) return
  let failed = false
  try {
    await action.invoke()
  } catch {
    failed = true
  }
  if (!owner.active) return
  showFeedback(document, owner, failed ? action.failure : action.success, failed)
}

function actionButton(
  document: Document,
  action: HostNavigationCollectionAction,
  returnFocus: HTMLElement | undefined,
  menuItem: boolean,
  owner: MountOwner,
  beforeInvoke?: () => void,
): Readonly<{ button: HTMLButtonElement; dispose: () => void }> {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = menuItem ? 'cordisx-navigation-menu-item' : 'cordisx-navigation-direct-action'
  button.dataset.tone = action.tone
  button.disabled = action.disabled
  button.setAttribute('aria-label', action.ariaLabel)
  if (!menuItem) button.setAttribute('aria-pressed', String(action.pressed))
  button.title = action.disabledReason ?? action.ariaLabel
  const iconSlot = document.createElement('span')
  iconSlot.className = menuItem
    ? 'cordisx-navigation-menu-icon-slot'
    : 'cordisx-navigation-action-icon-slot'
  iconSlot.setAttribute('aria-hidden', 'true')
  if (action.icon !== undefined) {
    iconSlot.append(createHostSurfaceIcon(document, action.icon, {
      state: action.disabled ? 'disabled' : action.tone === 'danger' ? 'danger' : action.pressed ? 'selected' : 'default',
    }))
  }
  button.append(iconSlot)
  if (menuItem) {
    const label = document.createElement('span')
    label.textContent = action.label
    button.append(label)
    button.setAttribute('role', 'menuitem')
  }
  const onClick = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    beforeInvoke?.()
    void invoke(document, action, returnFocus ?? button, owner)
  }
  button.addEventListener('click', onClick)
  return { button, dispose: () => button.removeEventListener('click', onClick) }
}

export function mountNavigationCollectionActions(
  document: Document,
  container: HTMLElement,
  actions: readonly HostNavigationCollectionAction[],
): () => void {
  const owner: MountOwner = { active: true, cleanups: new Set() }
  const direct = actions.filter(action => action.placement === 'direct')
  const overflow = actions.filter(action => action.placement === 'overflow')
  for (const action of direct) {
    const mounted = actionButton(document, action, undefined, false, owner)
    own(owner, mounted.dispose)
    container.append(mounted.button)
  }

  if (overflow.length > 0) {
    const copy = hostCopy(document)
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'cordisx-navigation-more-action'
    trigger.setAttribute('aria-label', copy.more)
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.append(createHostSurfaceIcon(document, 'host:more'))
    container.append(trigger)
    let menu: HTMLElement | undefined
    let menuDisposers: (() => void)[] = []

    const close = (restoreFocus = true): void => {
      if (menu === undefined) return
      for (const dispose of menuDisposers.splice(0)) dispose()
      menu.remove()
      menu = undefined
      trigger.setAttribute('aria-expanded', 'false')
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('keydown', onDocumentKey, true)
      if (restoreFocus && owner.active && trigger.isConnected) trigger.focus()
    }
    const onOutside = (event: PointerEvent): void => {
      const path = event.composedPath()
      if (menu !== undefined && !path.includes(menu) && !path.includes(trigger)) close(false)
    }
    const onDocumentKey = (event: KeyboardEvent): void => {
      if (menu === undefined) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      const items = focusable(menu)
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      let next: number | undefined
      if (event.key === 'ArrowDown') next = current < 0 || current === items.length - 1 ? 0 : current + 1
      else if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = items.length - 1
      if (next !== undefined) {
        event.preventDefault()
        items[next]?.focus()
      }
    }
    const open = (): void => {
      if (!owner.active || menu !== undefined) return
      menu = document.createElement('div')
      menu.className = 'cordisx-navigation-menu'
      menu.setAttribute('role', 'menu')
      for (const action of overflow) {
        const mounted = actionButton(document, action, trigger, true, owner, () => close())
        menuDisposers.push(mounted.dispose)
        menu.append(mounted.button)
      }
      document.body.append(menu)
      const rect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const view = document.defaultView!
      menu.style.left = `${Math.max(8, Math.min(rect.right - menuRect.width, view.innerWidth - menuRect.width - 8))}px`
      menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, view.innerHeight - menuRect.height - 8))}px`
      trigger.setAttribute('aria-expanded', 'true')
      document.addEventListener('pointerdown', onOutside, true)
      document.addEventListener('keydown', onDocumentKey, true)
      focusable(menu)[0]?.focus()
    }
    const onTrigger = (event: MouseEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (menu === undefined) open()
      else close()
    }
    trigger.addEventListener('click', onTrigger)
    own(owner, () => trigger.removeEventListener('click', onTrigger))
    own(owner, () => close(false))
  }

  return () => {
    disposeOwner(owner)
    container.replaceChildren()
  }
}
