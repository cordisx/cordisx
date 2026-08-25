export type HostCollectionLayout = 'cards' | 'rows'

/**
 * Catalogs with dense, host-owned machine metadata use the same icon rhythm as
 * Manager list rows instead of promoting each Material glyph into an avatar.
 */
export type HostCollectionDensity = 'default' | 'compact'

export type HostCollectionStatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'progress'

export type HostCollectionActionTone = 'neutral' | 'danger'

export interface HostCollectionTooltipAdapter {
  attach(target: HTMLElement, text: () => string, placement?: 'top' | 'bottom'): () => void
  hide?(): void
}

export interface HostCollectionAction {
  readonly id: string
  readonly label: string
  readonly icon: () => Node
  readonly placement: 'direct' | 'overflow'
  readonly priority?: number
  readonly tone?: HostCollectionActionTone
  readonly disabled?: boolean
  readonly unavailableReason?: string
  readonly onInvoke?: () => void | Promise<void>
}

export interface HostCollectionStatus {
  readonly label: string
  readonly tone: HostCollectionStatusTone
  readonly detail?: string
}

export interface HostCollectionItem {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly machineId?: string
  readonly searchText?: readonly string[]
  readonly icon: () => Node
  /** A product avatar can replace the generic icon while retaining a compact type badge. */
  readonly avatar?: { readonly label: string; readonly badge?: () => Node }
  readonly status?: HostCollectionStatus
  /** Status normally belongs to an icon; account cards may place it at the card edge. */
  readonly statusPosition?: 'icon' | 'card'
  readonly actions?: readonly HostCollectionAction[]
  readonly openLabel?: string
  readonly onOpen?: () => void
}

export interface HostCollectionSearchOptions {
  readonly label?: string
  readonly placeholder?: string
  readonly clearLabel?: string
  readonly query?: string
  readonly onQueryChange?: (query: string) => void
  readonly icon?: () => Node
  readonly clearIcon?: () => Node
}

export interface HostCollectionSearchOmission {
  readonly enabled: false
  readonly reason: string
}

export interface HostCollectionOptions {
  readonly id: string
  readonly label: string
  readonly items: readonly HostCollectionItem[]
  readonly layout?: HostCollectionLayout
  readonly density?: HostCollectionDensity
  readonly search?: HostCollectionSearchOptions | HostCollectionSearchOmission
  readonly emptyLabel?: string
  readonly noMatchesLabel?: string
  readonly moreLabel?: string
  readonly moreIcon?: () => Node
  readonly tooltips?: HostCollectionTooltipAdapter
  readonly attachPortalTheme?: (portal: HTMLElement) => () => void
}

export interface HostCollectionView {
  readonly element: HTMLElement
  readonly dispose: () => void
}

interface HighlightedField {
  readonly element: HTMLElement
  readonly text: string
}

interface RenderedItem {
  readonly item: HostCollectionItem
  readonly root: HTMLElement
  readonly searchable: string
  readonly highlightedFields: readonly HighlightedField[]
}

export const HOST_COLLECTION_STYLES = String.raw`
  .cxc-collection {
    --cxc-icon-seat-size: 36px;
    --cxc-icon-glyph-size: 24px;
    min-width: 0;
  }
  .cxc-collection[data-density="compact"] {
    --cxc-icon-seat-size: var(--cx-compact-list-icon-seat, 22px);
    --cxc-icon-glyph-size: var(--cx-compact-list-icon-glyph, 16px);
  }
  .cxc-search {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 38px;
    box-sizing: border-box;
    border: 1px solid var(--cx-border);
    border-radius: 9px;
    background: var(--cx-surface-raised);
  }
  .cxc-search:focus-within { border-color: var(--cx-primary); outline: 2px solid var(--cx-focus); outline-offset: 2px; }
  .cxc-search-icon { display: grid; place-items: center; width: 18px; height: 18px; margin-left: 10px; flex: none; color: var(--cx-muted); }
  .cxc-search-input { width: 100%; min-width: 0; padding: 9px 0; border: 0; outline: 0; background: transparent; color: var(--cx-text); font: inherit; }
  .cxc-search-clear { display: grid; place-items: center; width: 28px; height: 28px; margin-right: 3px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--cx-muted); cursor: pointer; }
  .cxc-search-clear:hover, .cxc-search-clear:focus-visible { background: var(--cx-hover); color: var(--cx-text); }
  .cxc-search-clear:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 1px; }
  .cxc-search-clear[hidden] { display: none; }
  .cxc-list {
    display: grid;
    /* Collapse unused tracks and let the remaining product cards use the
       complete content width. This avoids a blank trailing column without
       requiring every catalog to carry its own width exception. */
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
    /* A scrollable list owns the remaining height, not each product card. */
    align-content: start;
    align-items: start;
    gap: 8px;
    margin-top: 12px;
  }
  .cxc-list[data-layout="rows"] { grid-template-columns: minmax(0, 1fr); }
  .cxc-listitem { min-width: 0; align-self: start; }
  .cxc-card {
    position: relative;
    container-type: inline-size;
    min-width: 0;
    height: auto;
    align-self: start;
    box-sizing: border-box;
    border: 1px solid var(--cx-border);
    border-radius: 11px;
    background: var(--cx-surface-raised);
    color: var(--cx-text);
  }
  .cxc-card:hover, .cxc-card:focus-within, .cxc-card[data-action-menu-open="true"] { border-color: var(--cx-primary); background: var(--cx-hover); }
  .cxc-primary {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    width: 100%;
    min-width: 0;
    min-height: 82px;
    height: auto;
    box-sizing: border-box;
    padding: 12px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  div.cxc-primary { cursor: default; }
  .cxc-primary:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: -3px; }
  .cxc-icon-seat { position: relative; display: grid; place-items: center; width: var(--cxc-icon-seat-size); height: var(--cxc-icon-seat-size); flex: none; color: var(--cx-muted); }
  .cxc-icon-seat > :first-child { width: var(--cxc-icon-glyph-size); height: var(--cxc-icon-glyph-size); max-width: 100%; max-height: 100%; pointer-events: none; }
  /* Host icon wrappers may carry SVG width/height attributes from their source
     asset. Keep the rendered glyph inside the shared seat regardless of token. */
  .cxc-icon-seat > :first-child > svg { display: block; width: 100% !important; height: 100% !important; }
  .cxc-status {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 10px;
    height: 10px;
    box-sizing: border-box;
    border: 2px solid var(--cx-surface-raised);
    border-radius: 50%;
    background: var(--cx-muted);
    box-shadow: 0 0 0 1px rgb(0 0 0 / 16%);
  }
  .cxc-status[data-tone="success"] { background: var(--cx-success, #4ade80); }
  .cxc-status[data-tone="warning"] { background: var(--cx-warning, #fbbf24); }
  .cxc-status[data-tone="danger"] { background: var(--cx-danger, #fb7185); }
  .cxc-status[data-tone="progress"] { background: var(--cx-progress, #60a5fa); }
  .cxc-avatar { display: grid; place-items: center; width: var(--cxc-icon-seat-size); height: var(--cxc-icon-seat-size); border-radius: 50%; background: var(--cx-hover); color: var(--cx-text); font-size: 12px; font-weight: 700; }
  .cxc-avatar-badge { position: absolute; right: -3px; bottom: -3px; display: grid; place-items: center; width: 16px; height: 16px; box-sizing: border-box; border: 2px solid var(--cx-surface-raised); border-radius: 50%; background: var(--cx-surface); color: var(--cx-muted); }
  .cxc-avatar-badge > * { width: 10px; height: 10px; }
  .cxc-card > .cxc-status[data-position="card"] { top: 10px; right: 10px; bottom: auto; z-index: 1; }
  .cxc-copy { min-width: 0; flex: 1 1 auto; }
  .cxc-title { display: block; overflow: hidden; color: var(--cx-text); font-size: 12px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
  .cxc-description { display: -webkit-box; margin-top: 3px; overflow: hidden; color: var(--cx-muted); font-size: 11px; line-height: 1.42; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxc-machine-id { display: block; margin-top: 5px; overflow: hidden; color: var(--cx-muted); font: 10px/1.35 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; user-select: text; }
  .cxc-actions {
    position: absolute;
    z-index: 2;
    top: 7px;
    right: 7px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--cx-surface-raised) 88%, transparent);
    box-shadow: -12px 0 16px color-mix(in srgb, var(--cx-surface-raised) 76%, transparent);
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
  }
  .cxc-card:hover .cxc-actions,
  .cxc-card:focus-within .cxc-actions,
  .cxc-card[data-action-menu-open="true"] .cxc-actions { opacity: 1; pointer-events: auto; }
  .cxc-action, .cxc-menu-trigger { display: inline-grid; place-items: center; width: 32px; min-width: 32px; height: 32px; min-height: 32px; flex: none; box-sizing: border-box; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--cx-muted); cursor: pointer; }
  .cxc-action:hover:not(:disabled), .cxc-menu-trigger:hover { background: var(--cx-hover); color: var(--cx-text); }
  .cxc-action:focus-visible, .cxc-menu-trigger:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 1px; }
  .cxc-action:disabled { cursor: default; opacity: var(--cx-disabled, .4); }
  .cxc-action[data-tone="danger"] { color: var(--cx-danger); }
  .cxc-action > *, .cxc-menu-trigger > * { width: 17px; height: 17px; pointer-events: none; }
  .cxc-menu-popup { position: fixed; z-index: 2147483646; width: max-content; min-width: 160px; max-width: min(240px, calc(100vw - 32px)); padding: 5px; border: 1px solid var(--cx-border); border-radius: 10px; background: var(--cx-surface-raised); color: var(--cx-text); box-shadow: 0 14px 44px var(--cx-shadow); font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
  .cxc-menu-item { display: flex; align-items: center; gap: 9px; width: 100%; box-sizing: border-box; padding: 8px 9px; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; text-align: left; font: inherit; }
  .cxc-menu-item:hover:not(:disabled), .cxc-menu-item:focus-visible { background: var(--cx-hover); outline: none; }
  .cxc-menu-item:disabled { cursor: default; opacity: var(--cx-disabled, .4); }
  .cxc-menu-item[data-tone="danger"] { color: var(--cx-danger); }
  .cxc-menu-item > :first-child { width: 16px; height: 16px; flex: none; pointer-events: none; }
  .cxc-empty { grid-column: 1 / -1; padding: 28px 12px; color: var(--cx-muted); font-size: 11px; text-align: center; }
  .cxc-search-match { padding: 0; border-radius: 2px; background: color-mix(in srgb, var(--cx-warning, #fbbf24) 25%, transparent); color: inherit; }
  @media (prefers-reduced-motion: reduce) { .cxc-actions { transition: none; } }
`

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function appendIcon(target: HTMLElement, icon: () => Node): void {
  const node = icon()
  if (node instanceof target.ownerDocument.defaultView!.Element) {
    node.setAttribute('aria-hidden', 'true')
    node.setAttribute('focusable', 'false')
  }
  target.append(node)
}

function renderHighlight(field: HighlightedField, query: string): void {
  field.element.replaceChildren()
  const needle = query.trim()
  if (needle === '') {
    field.element.textContent = field.text
    return
  }
  const index = field.text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (index < 0) {
    field.element.textContent = field.text
    return
  }
  field.element.append(field.text.slice(0, index))
  const mark = field.element.ownerDocument.createElement('mark')
  mark.className = 'cxc-search-match'
  mark.textContent = field.text.slice(index, index + needle.length)
  field.element.append(mark, field.text.slice(index + needle.length))
}

function stopActionEvent(event: Event): void {
  event.stopPropagation()
}

function enabledMenuItems(popup: HTMLElement): HTMLButtonElement[] {
  return [...popup.querySelectorAll<HTMLButtonElement>('.cxc-menu-item:not(:disabled)')]
}

export function createHostCollection(document: Document, options: HostCollectionOptions): HostCollectionView {
  if (options.search !== undefined && 'enabled' in options.search && options.search.enabled === false && options.search.reason.trim() === '') {
    throw new Error('A non-searchable Host collection requires a product reason.')
  }

  const cleanups: Array<() => void> = []
  const root = document.createElement('section')
  root.className = 'cxc-collection'
  root.dataset.hostCollection = options.id
  root.dataset.density = options.density ?? 'default'
  root.setAttribute('aria-label', options.label)

  const list = document.createElement('div')
  list.className = 'cxc-list'
  list.dataset.layout = options.layout ?? 'cards'
  list.setAttribute('role', 'list')
  list.setAttribute('aria-label', options.label)

  const rendered: RenderedItem[] = []
  let activeMenu: { popup: HTMLElement, trigger: HTMLButtonElement, card: HTMLElement, detachTheme?: () => void } | undefined

  const restoreTriggerFocus = (trigger: HTMLButtonElement): void => {
    if (!trigger.isConnected) return
    trigger.focus({ preventScroll: true })
    document.defaultView?.queueMicrotask(() => {
      if (activeMenu === undefined && trigger.isConnected) trigger.focus({ preventScroll: true })
    })
  }

  const closeMenu = (restoreFocus: boolean): void => {
    if (activeMenu === undefined) return
    const { popup, trigger, card, detachTheme } = activeMenu
    activeMenu = undefined
    popup.remove()
    detachTheme?.()
    card.removeAttribute('data-action-menu-open')
    trigger.setAttribute('aria-expanded', 'false')
    options.tooltips?.hide?.()
    if (restoreFocus) restoreTriggerFocus(trigger)
  }

  const positionMenu = (): void => {
    if (activeMenu === undefined) return
    const edge = 8
    const gap = 5
    const triggerRect = activeMenu.trigger.getBoundingClientRect()
    const popupRect = activeMenu.popup.getBoundingClientRect()
    const view = document.defaultView
    if (view === null || !activeMenu.trigger.isConnected) {
      closeMenu(false)
      return
    }
    const left = Math.min(
      Math.max(edge, triggerRect.right - popupRect.width),
      Math.max(edge, view.innerWidth - popupRect.width - edge),
    )
    const above = triggerRect.top - popupRect.height - gap
    const top = triggerRect.bottom + popupRect.height + edge <= view.innerHeight
      ? triggerRect.bottom + gap
      : Math.max(edge, above)
    activeMenu.popup.style.left = `${Math.round(left)}px`
    activeMenu.popup.style.top = `${Math.round(top)}px`
  }

  const openMenu = (trigger: HTMLButtonElement, card: HTMLElement, actions: readonly HostCollectionAction[]): void => {
    if (activeMenu?.trigger === trigger) {
      closeMenu(true)
      return
    }
    closeMenu(false)
    const popup = document.createElement('div')
    popup.className = 'cxc-menu-popup'
    // Menus are portaled to body for clipping-safe positioning. Copy the
    // trigger's computed font so their chrome still belongs to the Host seat.
    const triggerFont = document.defaultView?.getComputedStyle(trigger).font
    if (triggerFont !== undefined && triggerFont !== '') popup.style.font = triggerFont
    const controls = trigger.getAttribute('aria-controls')
    if (controls !== null) popup.id = controls
    popup.setAttribute('role', 'menu')
    popup.setAttribute('aria-label', options.moreLabel ?? '更多操作')
    popup.addEventListener('pointerdown', stopActionEvent)
    popup.addEventListener('click', stopActionEvent)
    for (const action of actions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cxc-menu-item'
      button.dataset.collectionAction = action.id
      button.dataset.tone = action.tone ?? 'neutral'
      button.setAttribute('role', 'menuitem')
      button.disabled = action.disabled === true
      button.setAttribute('aria-label', action.unavailableReason === undefined ? action.label : `${action.label}：${action.unavailableReason}`)
      if (button.disabled) {
        button.setAttribute('aria-disabled', 'true')
        if (action.unavailableReason !== undefined) {
          button.setAttribute('aria-description', action.unavailableReason)
          button.title = action.unavailableReason
        }
      }
      appendIcon(button, action.icon)
      button.append(document.createTextNode(action.label))
      if (!button.disabled && action.onInvoke !== undefined) {
        button.addEventListener('click', () => {
          closeMenu(true)
          void action.onInvoke?.()
        })
      }
      popup.append(button)
    }
    popup.addEventListener('keydown', onMenuKeyDown)
    document.body.append(popup)
    const detachTheme = options.attachPortalTheme?.(popup)
    activeMenu = { popup, trigger, card, ...(detachTheme === undefined ? {} : { detachTheme }) }
    card.dataset.actionMenuOpen = 'true'
    trigger.setAttribute('aria-expanded', 'true')
    positionMenu()
    enabledMenuItems(popup)[0]?.focus()
  }

  const onDocumentPointerDown = (event: Event): void => {
    if (activeMenu === undefined) return
    const target = event.target
    if (target instanceof document.defaultView!.Node && (activeMenu.popup.contains(target) || activeMenu.trigger.contains(target))) return
    closeMenu(false)
  }
  function onMenuKeyDown(event: KeyboardEvent): void {
    if (activeMenu === undefined) return
    const target = event.target
    if (!(target instanceof document.defaultView!.Node) || !activeMenu.popup.contains(target)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
      return
    }
    const items = enabledMenuItems(activeMenu.popup)
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown'
      ? items[(current + 1 + items.length) % items.length]
      : event.key === 'ArrowUp'
        ? items[(current - 1 + items.length) % items.length]
        : event.key === 'Home'
          ? items[0]
          : event.key === 'End'
            ? items.at(-1)
            : undefined
    if (next !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      next.focus()
    }
  }
  const onViewportChange = (): void => positionMenu()
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.defaultView?.addEventListener('resize', onViewportChange)
  document.addEventListener('scroll', onViewportChange, true)
  cleanups.push(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true))
  cleanups.push(() => document.defaultView?.removeEventListener('resize', onViewportChange))
  cleanups.push(() => document.removeEventListener('scroll', onViewportChange, true))

  for (const item of options.items) {
    const listitem = document.createElement('div')
    listitem.className = 'cxc-listitem'
    listitem.setAttribute('role', 'listitem')
    listitem.dataset.collectionItem = item.id
    const card = document.createElement('article')
    card.className = 'cxc-card'

    const primary = item.onOpen === undefined ? document.createElement('div') : document.createElement('button')
    primary.className = 'cxc-primary'
    if (primary instanceof document.defaultView!.HTMLButtonElement) {
      primary.type = 'button'
      primary.dataset.collectionOpen = item.id
      primary.setAttribute('aria-label', item.openLabel ?? `打开 ${item.title} 详情`)
      if (item.status !== undefined) primary.setAttribute('aria-description', item.status.detail ?? item.status.label)
      primary.addEventListener('click', () => item.onOpen?.())
    }

    const icon = document.createElement('span')
    icon.className = 'cxc-icon-seat'
    if (item.avatar === undefined) appendIcon(icon, item.icon)
    else {
      const avatar = document.createElement('span')
      avatar.className = 'cxc-avatar'
      avatar.setAttribute('role', 'img')
      avatar.setAttribute('aria-label', item.avatar.label)
      avatar.textContent = item.avatar.label.slice(0, 1).toLocaleUpperCase()
      icon.append(avatar)
      if (item.avatar.badge !== undefined) {
        const badge = document.createElement('span')
        badge.className = 'cxc-avatar-badge'
        appendIcon(badge, item.avatar.badge)
        icon.append(badge)
      }
    }
    if (item.status !== undefined) {
      const status = document.createElement('span')
      status.className = 'cxc-status'
      status.dataset.tone = item.status.tone
      status.setAttribute('role', 'img')
      status.setAttribute('aria-label', item.status.detail ?? item.status.label)
      if (item.statusPosition === 'card') {
        status.dataset.position = 'card'
        card.append(status)
      } else icon.append(status)
    }

    const copy = document.createElement('span')
    copy.className = 'cxc-copy'
    const title = document.createElement('span')
    title.className = 'cxc-title'
    title.textContent = item.title
    const highlightedFields: HighlightedField[] = [{ element: title, text: item.title }]
    copy.append(title)
    if (item.description !== undefined) {
      const description = document.createElement('span')
      description.className = 'cxc-description'
      description.textContent = item.description
      highlightedFields.push({ element: description, text: item.description })
      copy.append(description)
    }
    if (item.machineId !== undefined) {
      const machineId = document.createElement('code')
      machineId.className = 'cxc-machine-id'
      machineId.textContent = item.machineId
      highlightedFields.push({ element: machineId, text: item.machineId })
      copy.append(machineId)
    }
    primary.append(icon, copy)
    card.append(primary)

    if (item.onOpen !== undefined && item.status !== undefined && options.tooltips !== undefined) {
      cleanups.push(options.tooltips.attach(primary, () => item.status?.detail ?? item.status?.label ?? '', 'top'))
    }

    const direct = [...(item.actions ?? [])].filter(action => action.placement === 'direct').sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
    const overflow = [...(item.actions ?? [])].filter(action => action.placement === 'overflow').sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
    if (direct.length > 0 || overflow.length > 0) {
      const actions = document.createElement('div')
      actions.className = 'cxc-actions'
      actions.addEventListener('pointerdown', stopActionEvent)
      actions.addEventListener('click', stopActionEvent)
      for (const action of direct) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'cxc-action'
        button.dataset.collectionAction = action.id
        button.dataset.tone = action.tone ?? 'neutral'
        button.disabled = action.disabled === true
        button.setAttribute('aria-label', action.unavailableReason === undefined ? action.label : `${action.label}：${action.unavailableReason}`)
        appendIcon(button, action.icon)
        if (!button.disabled && action.onInvoke !== undefined) button.addEventListener('click', () => { void action.onInvoke?.() })
        if (options.tooltips !== undefined) cleanups.push(options.tooltips.attach(button, () => action.unavailableReason ?? action.label, 'top'))
        actions.append(button)
      }
      if (overflow.length > 0) {
        const trigger = document.createElement('button')
        trigger.type = 'button'
        trigger.className = 'cxc-menu-trigger'
        trigger.setAttribute('aria-label', options.moreLabel ?? '更多操作')
        trigger.setAttribute('aria-haspopup', 'menu')
        trigger.setAttribute('aria-expanded', 'false')
        trigger.setAttribute('aria-controls', `cxc-menu-${options.id}-${item.id}`.replace(/[^a-zA-Z0-9_-]/g, '-'))
        if (options.moreIcon !== undefined) appendIcon(trigger, options.moreIcon)
        trigger.addEventListener('click', () => openMenu(trigger, card, overflow))
        if (options.tooltips !== undefined) cleanups.push(options.tooltips.attach(trigger, () => options.moreLabel ?? '更多操作', 'top'))
        actions.append(trigger)
      }
      card.append(actions)
    }

    listitem.append(card)
    list.append(listitem)
    rendered.push({
      item,
      root: listitem,
      searchable: normalizeSearch([item.title, item.description, item.machineId, ...(item.searchText ?? [])].filter((value): value is string => value !== undefined).join(' ')),
      highlightedFields,
    })
  }

  const empty = document.createElement('div')
  empty.className = 'cxc-empty'
  empty.setAttribute('role', 'status')
  empty.hidden = options.items.length > 0
  empty.textContent = options.emptyLabel ?? '暂无数据'
  list.append(empty)

  const applyQuery = (rawQuery: string): void => {
    const query = normalizeSearch(rawQuery)
    let visible = 0
    for (const entry of rendered) {
      const matches = query === '' || entry.searchable.includes(query)
      entry.root.hidden = !matches
      if (matches) visible += 1
      for (const field of entry.highlightedFields) renderHighlight(field, rawQuery)
    }
    empty.hidden = visible > 0
    empty.textContent = options.items.length === 0 || query === '' ? options.emptyLabel ?? '暂无数据' : options.noMatchesLabel ?? '没有匹配结果'
  }

  const search = options.search
  if (search === undefined || !('enabled' in search)) {
    const toolbar = document.createElement('div')
    toolbar.className = 'cxc-search'
    toolbar.setAttribute('role', 'search')
    const searchOptions = search ?? {}
    if (searchOptions.icon !== undefined) {
      const icon = document.createElement('span')
      icon.className = 'cxc-search-icon'
      appendIcon(icon, searchOptions.icon)
      toolbar.append(icon)
    }
    const input = document.createElement('input')
    input.className = 'cxc-search-input'
    input.type = 'search'
    input.value = searchOptions.query ?? ''
    input.placeholder = searchOptions.placeholder ?? `搜索${options.label}`
    input.setAttribute('aria-label', searchOptions.label ?? `搜索${options.label}`)
    input.dataset.collectionSearch = options.id
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'cxc-search-clear'
    clear.setAttribute('aria-label', searchOptions.clearLabel ?? '清除搜索')
    if (searchOptions.clearIcon !== undefined) appendIcon(clear, searchOptions.clearIcon)
    else clear.textContent = '×'
    const update = (): void => {
      clear.hidden = input.value === ''
      applyQuery(input.value)
      searchOptions.onQueryChange?.(input.value)
    }
    input.addEventListener('input', update)
    input.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || input.value === '') return
      event.preventDefault()
      input.value = ''
      update()
    })
    clear.addEventListener('click', event => {
      event.stopPropagation()
      input.value = ''
      update()
      input.focus()
    })
    toolbar.append(input, clear)
    root.append(toolbar)
    clear.hidden = input.value === ''
    applyQuery(input.value)
  } else {
    root.dataset.searchOmissionReason = search.reason
    applyQuery('')
  }

  root.append(list)
  return {
    element: root,
    dispose: () => {
      closeMenu(false)
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      root.remove()
    },
  }
}
