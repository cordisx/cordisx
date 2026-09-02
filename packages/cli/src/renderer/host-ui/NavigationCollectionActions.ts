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

function showFeedback(document: Document, message: string, failed: boolean): void {
  const toast = document.createElement('div')
  toast.className = 'cordisx-navigation-feedback'
  toast.dataset.tone = failed ? 'danger' : 'neutral'
  toast.setAttribute('role', failed ? 'alert' : 'status')
  toast.setAttribute('aria-live', failed ? 'assertive' : 'polite')
  toast.textContent = message
  document.body.append(toast)
  document.defaultView?.setTimeout(() => toast.remove(), 2200)
}

function confirmAction(
  document: Document,
  action: HostNavigationCollectionAction,
  returnFocus: HTMLElement,
): Promise<boolean> {
  if (action.confirmation === undefined) return Promise.resolve(true)
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
    title.textContent = action.confirmation.title
    dialog.setAttribute('aria-labelledby', title.id)
    const description = document.createElement('div')
    description.className = 'cordisx-navigation-confirm-description'
    description.id = `${title.id}-description`
    description.textContent = action.confirmation.description
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
    confirm.textContent = action.confirmation.confirmLabel
    footer.append(cancel, confirm)
    dialog.append(title, description, footer)
    backdrop.append(dialog)
    const settle = (accepted: boolean): void => {
      backdrop.remove()
      document.removeEventListener('keydown', onKeyDown, true)
      if (returnFocus.isConnected) returnFocus.focus()
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
    cancel.addEventListener('click', () => settle(false))
    confirm.addEventListener('click', () => settle(true))
    backdrop.addEventListener('pointerdown', event => {
      if (event.target === backdrop) settle(false)
    })
    document.addEventListener('keydown', onKeyDown, true)
    document.body.append(backdrop)
    cancel.focus()
  })
}

async function invoke(
  document: Document,
  action: HostNavigationCollectionAction,
  returnFocus: HTMLElement,
): Promise<void> {
  if (!await confirmAction(document, action, returnFocus)) return
  try {
    await action.invoke()
    showFeedback(document, action.success, false)
  } catch {
    showFeedback(document, action.failure, true)
  }
}

function actionButton(
  document: Document,
  action: HostNavigationCollectionAction,
  returnFocus: HTMLElement,
  menuItem: boolean,
): HTMLButtonElement {
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
  button.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    void invoke(document, action, returnFocus)
  })
  return button
}

export function mountNavigationCollectionActions(
  document: Document,
  container: HTMLElement,
  actions: readonly HostNavigationCollectionAction[],
): () => void {
  const direct = actions.filter(action => action.placement === 'direct')
  const overflow = actions.filter(action => action.placement === 'overflow')
  const disposers: (() => void)[] = []
  for (const action of direct) container.append(actionButton(document, action, container, false))
  if (overflow.length === 0) return () => { container.replaceChildren() }

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

  const close = (restoreFocus = true): void => {
    if (menu === undefined) return
    menu.remove()
    menu = undefined
    trigger.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onDocumentKey, true)
    if (restoreFocus && trigger.isConnected) trigger.focus()
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
    if (menu !== undefined) return
    menu = document.createElement('div')
    menu.className = 'cordisx-navigation-menu'
    menu.setAttribute('role', 'menu')
    for (const action of overflow) {
      const button = actionButton(document, action, trigger, true)
      button.addEventListener('click', () => close(), { once: true })
      menu.append(button)
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
  disposers.push(() => trigger.removeEventListener('click', onTrigger), () => close(false))
  return () => {
    for (const dispose of disposers) dispose()
    container.replaceChildren()
  }
}
