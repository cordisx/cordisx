import { type CordisXIconToken } from '../../contracts.js'
import { createManagerIcon, type ManagerIconToken } from '.././icons.js'
import { create, createAdaptiveBrandMark } from './dom.js'
import { ManagerSnapshot } from './model.js'
import { ABOUT_ACTIONS } from './presentation.js'

export interface AboutDependencies {
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
  document: Document
  configureExternalLink: <T extends HTMLAnchorElement>(link: T, href: string) => T
  content: HTMLDivElement
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createAbout(dependencies: AboutDependencies) {
  const renderAbout = (snapshot: ManagerSnapshot): void => {
    dependencies.setHeading('项目、社区与支持入口', snapshot, { brand: true })
    const identity = create(dependencies.document, 'div', 'cxm-about-identity')
    const mark = createAdaptiveBrandMark(dependencies.document)
    mark.classList.add('cxm-about-mark')
    const identityCopy = create(dependencies.document, 'div', 'cxm-about-identity-copy')
    identityCopy.append(
      create(dependencies.document, 'div', 'cxm-about-name', 'CordisX'),
      create(dependencies.document, 'div', 'cxm-about-version', `v${snapshot.version}`),
    )
    identity.append(mark, identityCopy)

    const actions = create(dependencies.document, 'div', 'cxm-about-actions')
    actions.setAttribute('role', 'list')
    actions.setAttribute('aria-label', 'CordisX 项目入口')
    for (const action of ABOUT_ACTIONS) {
      const item = create(dependencies.document, 'div', 'cxm-about-action-item')
      item.setAttribute('role', 'listitem')
      const link = create(dependencies.document, 'a', 'cxm-about-action')
      dependencies.configureExternalLink(link, action.href)
      const body = create(dependencies.document, 'span', 'cxm-about-action-body')
      body.append(
        create(dependencies.document, 'span', 'cxm-about-action-title', action.label),
        create(dependencies.document, 'span', 'cxm-about-action-copy', action.description),
      )
      const arrow = createManagerIcon(dependencies.document, 'external-link', 'cxm-about-action-arrow')
      link.append(body, arrow)
      item.append(link)
      actions.append(item)
    }
    dependencies.content.append(identity, actions)
  }
  return { renderAbout }
}
