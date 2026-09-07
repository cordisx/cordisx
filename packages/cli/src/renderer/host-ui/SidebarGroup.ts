import { renderHostIconSvg } from '../icons.js'

/** Host-owned disclosure; only view state survives a collection snapshot refresh. */
export class SidebarGroupState {
  private readonly collapsed = new Set<string>()

  reconcile(ids: readonly string[]): void {
    const current = new Set(ids)
    for (const id of this.collapsed) if (!current.has(id)) this.collapsed.delete(id)
  }

  create(document: Document, id: string, label: string): { section: HTMLElement; content: HTMLElement } {
    const section = document.createElement('section')
    section.className = 'cordisx-navigation-group'
    section.dataset.navigationGroup = id
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
    const content = document.createElement('div')
    content.className = 'cordisx-navigation-group-items'
    content.id = `cordisx-navigation-group-${encodeURIComponent(id)}`
    toggle.setAttribute('aria-controls', content.id)
    const project = (): void => {
      const expanded = !this.collapsed.has(id)
      toggle.setAttribute('aria-expanded', String(expanded))
      content.hidden = !expanded
    }
    toggle.addEventListener('click', () => {
      if (this.collapsed.has(id)) this.collapsed.delete(id)
      else this.collapsed.add(id)
      project()
    })
    project()
    heading.append(toggle)
    section.append(heading, content)
    return { section, content }
  }
}
