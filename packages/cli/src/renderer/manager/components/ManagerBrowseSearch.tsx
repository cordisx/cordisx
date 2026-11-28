import type { ReactNode } from 'react'
import { SearchToolbar } from '../../host-ui/SearchToolbar.js'
import { modelProviderCopy } from '../../model-provider-copy.js'
import { managerCopy, productLocale } from '../../ui-copy.js'

export type ManagerBrowseSearchKind = 'plugins' | 'model-services' | 'marketplace' | 'extension-points' | 'routes'

/** The same Host search toolbar is used before and after a Manager connects. */
export function ManagerBrowseSearch({ kind, locale, value, onChange, disabled, actions }: {
  readonly kind: ManagerBrowseSearchKind
  readonly locale: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly actions?: ReactNode
}) {
  const field = kind === 'plugins'
    ? {
      label: managerCopy(locale, 'plugins.collection-search-label'),
      placeholder: managerCopy(locale, 'plugins.collection-search-placeholder'),
    }
    : kind === 'extension-points'
    ? {
      label: managerCopy(locale, 'extension.search-label'),
      placeholder: managerCopy(locale, 'extension.search-placeholder'),
    }
    : kind === 'routes'
    ? {
      label: managerCopy(locale, 'routes.search-label'),
      placeholder: managerCopy(locale, 'routes.search-placeholder'),
    }
    : kind === 'model-services'
    ? {
      label: modelProviderCopy(locale).search,
      placeholder: modelProviderCopy(locale).search,
      toolbar: managerCopy(locale, 'catalog.tools'),
    }
    : productLocale(locale) === 'zh-CN'
    ? { label: '搜索插件…', placeholder: '搜索插件…', toolbar: '搜索和筛选商店插件' }
    : { label: 'Search plugins…', placeholder: 'Search plugins…', toolbar: 'Search and filter Marketplace plugins' }
  return (
    <SearchToolbar
      toolbarLabel={'toolbar' in field ? field.toolbar : field.label}
      aria-label={field.label}
      placeholder={field.placeholder}
      clearLabel={locale.startsWith('zh') ? '清除搜索' : 'Clear search'}
      value={value}
      onChange={onChange}
      disabled={disabled}
      actions={actions}
    />
  )
}
