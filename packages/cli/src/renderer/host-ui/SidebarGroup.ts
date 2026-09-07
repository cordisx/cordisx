import { renderHostIconSvg } from '../icons.js'

/** Host-owned disclosure; only view state survives a collection snapshot refresh. */
export class SidebarGroupState {
  private readonly collapsed = new Set<string>()
  private readonly headers = new Map<string, {
    heading: HTMLElement
    toggle: HTMLButtonElement
    title: HTMLElement
    content?: HTMLElement
  }>()

  reconcile(ids: readonly string[]): void {
    const current = new Set(ids)
    for (const id of this.collapsed) if (!current.has(id)) this.collapsed.delete(id)
    for (const id of this.headers.keys()) if (!current.has(id)) this.headers.delete(id)
  }

  create(document: Document, id: string, label: string): { section: HTMLElement; content: HTMLElement } {
    const section = document.createElement('section')
    section.className = 'cordisx-navigation-group'
    section.dataset.navigationGroup = id
    let header = this.headers.get(id)
    if (header === undefined || header.heading.ownerDocument !== document) {
      const heading = document.createElement('div')
      heading.className = 'cordisx-navigation-group-heading'
      heading.setAttribute('role', 'heading')
      heading.setAttribute('aria-level', '2')
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'cordisx-navigation-group-toggle'
      const title = document.createElement('span')
      title.textContent = label
      const icon = renderHostIconSvg(document, 'control.chevron-down', { size: 14 }).svg
      icon.classList.add('cordisx-navigation-group-chevron')
      icon.setAttribute('aria-hidden', 'true')
      toggle.append(title, icon)
      header = { heading, toggle, title }
      const control = header
      toggle.addEventListener('click', () => {
        if (this.collapsed.has(id)) this.collapsed.delete(id)
        else this.collapsed.add(id)
        toggle.setAttribute('aria-expanded', String(!this.collapsed.has(id)))
        if (control.content !== undefined) control.content.hidden = this.collapsed.has(id)
      })
      heading.append(toggle)
      this.headers.set(id, header)
    }
    const { heading, toggle, title } = header
    title.textContent = label
    const content = document.createElement('div')
    content.className = 'cordisx-navigation-group-items'
    content.id = `cordisx-navigation-group-${encodeURIComponent(id)}`
    toggle.setAttribute('aria-controls', content.id)
    header.content = content
    toggle.setAttribute('aria-expanded', String(!this.collapsed.has(id)))
    content.hidden = this.collapsed.has(id)
    section.append(heading, content)
    return { section, content }
  }
}
