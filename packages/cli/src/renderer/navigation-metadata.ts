import type { CordisXPageMetadata } from '../contracts.js'
import type { CordisXI18nService } from './i18n.js'
import type { NavigationMetadataDiagnostic, NavigationProductMetadata } from './navigation-pages.js'

export function projectNavigationProductMetadata(
  i18n: CordisXI18nService,
  kind: 'route' | 'page',
  owner: string,
  qualifiedId: string,
  title: CordisXPageMetadata['title'] | undefined,
  description: CordisXPageMetadata['description'] | undefined,
  sites: Map<string, string>,
): NavigationProductMetadata {
  const diagnostics: NavigationMetadataDiagnostic[] = []
  const project = (
    field: 'title' | 'description',
    value: CordisXPageMetadata['title'] | undefined,
  ): string | undefined => {
    if (value === undefined) {
      diagnostics.push(Object.freeze({
        code: `metadata.missing-${field}`,
        field,
        message: `${kind} ${qualifiedId} should declare localized ${field} metadata`,
      }) as NavigationMetadataDiagnostic)
      return undefined
    }
    const site = `navigation:${kind}:${qualifiedId}:${field}`
    sites.set(site, owner)
    return i18n.resolveFor(owner, value, site).text
  }
  const projectedTitle = project('title', title)
  const projectedDescription = project('description', description)
  return Object.freeze({
    ...(projectedTitle === undefined ? {} : { title: projectedTitle }),
    ...(projectedDescription === undefined ? {} : { description: projectedDescription }),
    diagnostics: Object.freeze(diagnostics),
  })
}
