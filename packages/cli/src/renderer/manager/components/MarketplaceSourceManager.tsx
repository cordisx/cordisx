import { useEffect, useState } from 'react'
import { Input, Switch, Textarea } from 'tdesign-react'
import { HostEditorDialog } from '../../dialogs/internal.js'
import { HostIcon } from '../../host-ui/HostIcon.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { MoreMenu } from '../../host-ui/MoreMenu.js'

export interface MarketplaceSourceView {
  readonly url: string
  readonly enabled: boolean
  readonly name: string
  readonly description?: string
  readonly error?: string
  readonly official: boolean
  readonly removable: boolean
  readonly refreshing: boolean
  readonly local?: { readonly name?: string; readonly description?: string }
}

export interface MarketplaceSourceInput {
  readonly url: string
  readonly enabled: boolean
  readonly local?: { readonly name?: string; readonly description?: string }
}

export interface MarketplaceSourceManagerProps {
  readonly locale: string
  readonly sources: readonly MarketplaceSourceView[]
  readonly busyUrl?: string | undefined
  readonly onSave: (currentUrl: string | undefined, source: MarketplaceSourceInput) => Promise<void>
  readonly onSetEnabled: (url: string, enabled: boolean) => Promise<void>
  readonly onRemove: (url: string) => Promise<void>
  readonly onRefresh: (url: string) => Promise<void>
}

const COPY = {
  'zh-CN': {
    add: '添加来源',
    search: '搜索插件来源',
    searchPlaceholder: '搜索名称、介绍或 URL…',
    more: '更多来源操作',
    edit: '编辑来源',
    save: '保存',
    cancel: '取消',
    url: '来源地址',
    urlPlaceholder: 'https://…/marketplace.json',
    name: '本地名称（可选）',
    description: '本地描述（可选）',
    enabled: '启用',
    disabled: '停用',
    copy: '复制来源地址',
    remove: '删除来源',
    removeDescription: '删除后，该来源及其隐藏记录将从当前配置中移除。',
    error: '查看来源错误',
    errorTitle: '来源错误',
    retry: '重试',
    close: '关闭',
    empty: '尚未配置插件来源',
    noMatches: '没有匹配的插件来源',
  },
  en: {
    add: 'Add source',
    search: 'Search Marketplace sources',
    searchPlaceholder: 'Search names, descriptions, or URLs…',
    more: 'More source actions',
    edit: 'Edit source',
    save: 'Save',
    cancel: 'Cancel',
    url: 'Source URL',
    urlPlaceholder: 'https://…/marketplace.json',
    name: 'Local name (optional)',
    description: 'Local description (optional)',
    enabled: 'Enable',
    disabled: 'Disable',
    copy: 'Copy source URL',
    remove: 'Remove source',
    removeDescription: 'This source and its hidden records will be removed from the current configuration.',
    error: 'View source error',
    errorTitle: 'Source error',
    retry: 'Retry',
    close: 'Close',
    empty: 'No Marketplace sources are configured',
    noMatches: 'No Marketplace sources match your search',
  },
} as const

function localeKey(locale: string): keyof typeof COPY {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function optionalText(value: string): string | undefined {
  const normalized = value.trim()
  return normalized === '' ? undefined : normalized
}

export function MarketplaceSourceManager({
  locale,
  sources,
  busyUrl,
  onSave,
  onSetEnabled,
  onRemove,
  onRefresh,
}: MarketplaceSourceManagerProps) {
  const copy = COPY[localeKey(locale)]
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<MarketplaceSourceView | 'new'>()
  const [removingUrl, setRemovingUrl] = useState<string>()
  const [sourceError, setSourceError] = useState<{ readonly url: string; readonly message: string }>()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string>()
  const open = (source?: MarketplaceSourceView) => {
    setEditing(source ?? 'new')
    setUrl(source?.url ?? '')
    setName(source?.local?.name ?? '')
    setDescription(source?.local?.description ?? '')
    setError(undefined)
  }
  const close = () => {
    setEditing(undefined)
    setError(undefined)
  }
  const save = async () => {
    if (editing === undefined) return
    const currentUrl = editing === 'new' ? undefined : editing.url
    const localName = optionalText(name)
    const localDescription = optionalText(description)
    try {
      await onSave(currentUrl, {
        url: url.trim(),
        enabled: editing === 'new' ? true : editing.enabled,
        ...(localName === undefined && localDescription === undefined
          ? {}
          : {
            local: {
              ...(localName === undefined ? {} : { name: localName }),
              ...(localDescription === undefined ? {} : { description: localDescription }),
            },
          }),
      })
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleSources = normalizedQuery === ''
    ? sources
    : sources.filter(source =>
      [source.name, source.description ?? '', source.url]
        .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
    )
  const removing = removingUrl === undefined ? undefined : sources.find(source => source.url === removingUrl)
  const failed = sourceError === undefined ? undefined : sources.find(source => source.url === sourceError.url)
  useEffect(() => {
    if (sourceError === undefined) return
    if (failed?.error !== undefined && failed.error !== sourceError.message) {
      setSourceError({ url: failed.url, message: failed.error })
    } else if (failed === undefined || (failed.error === undefined && !failed.refreshing)) {
      setSourceError(undefined)
    }
  }, [failed, sourceError])
  const remove = async () => {
    if (removing === undefined) return
    try {
      await onRemove(removing.url)
      setRemovingUrl(undefined)
    } catch { /* existing Host management notification owns failure feedback */ }
  }
  const retry = async () => {
    if (failed === undefined) return
    try {
      await onRefresh(failed.url)
    } catch { /* keep the real source error visible until a successful snapshot clears it */ }
  }
  return (
    <>
      <div className="cxr-marketplace-tools" role="search" aria-label={copy.search}>
        <Input
          className="cxr-marketplace-search"
          value={query}
          aria-label={copy.search}
          placeholder={copy.searchPlaceholder}
          clearable
          prefixIcon={<HostIcon token="search" />}
          onChange={setQuery}
        />
        <span className="cxr-marketplace-tool-actions">
          <IconButton icon="marketplace-source-add" label={copy.add} onClick={() => open()} />
        </span>
      </div>
      <div className="cxr-list" data-marketplace-source-list="true">
        {visibleSources.map(source => {
          const busy = busyUrl === source.url
          return (
            <section className="cxr-card cxr-source-row" key={source.url} data-marketplace-source={source.url}>
              <span className="cxr-card-body">
                <span className="cxr-card-title">{source.name}</span>
                <span className="cxr-card-description">{source.description ?? source.error}</span>
                <code className="cxr-card-code">{source.url}</code>
              </span>
              <span className="cxr-source-actions">
                <Switch
                  value={source.enabled}
                  disabled={busy}
                  aria-label={`${source.enabled ? copy.disabled : copy.enabled} ${source.name}`}
                  onChange={enabled => void onSetEnabled(source.url, enabled)}
                />
                {source.error === undefined
                  ? null
                  : (
                    <IconButton
                      icon="diagnostics"
                      label={`${copy.error}: ${source.name}`}
                      description={source.error}
                      loading={source.refreshing}
                      theme="danger"
                      onClick={() => setSourceError({ url: source.url, message: source.error! })}
                    />
                  )}
                <MoreMenu
                  label={`${copy.more}: ${source.name}`}
                  items={[{
                    id: 'edit',
                    label: copy.edit,
                    icon: 'marketplace-source-edit',
                    disabled: busy,
                    onSelect: () => open(source),
                  }, {
                    id: 'copy',
                    label: copy.copy,
                    icon: 'marketplace-source-copy',
                    disabled: busy || window.navigator.clipboard === undefined,
                    onSelect: () => void window.navigator.clipboard.writeText(source.url),
                  }, {
                    id: 'remove',
                    label: copy.remove,
                    icon: 'delete',
                    theme: 'error',
                    disabled: busy || !source.removable,
                    onSelect: () => setRemovingUrl(source.url),
                  }]}
                />
              </span>
            </section>
          )
        })}
        {visibleSources.length === 0
          ? <div className="cxr-empty">{sources.length === 0 ? copy.empty : copy.noMatches}</div>
          : null}
      </div>
      <HostEditorDialog
        visible={editing !== undefined}
        header={editing === 'new' ? copy.add : copy.edit}
        confirmBtn={copy.save}
        cancelBtn={copy.cancel}
        showOwner={false}
        onClose={close}
        onConfirm={save}
      >
        <div className="cxr-dialog-form">
          <label>
            <span>{copy.url}</span>
            <Input value={url} placeholder={copy.urlPlaceholder} onChange={setUrl} />
          </label>
          <label>
            <span>{copy.name}</span>
            <Input value={name} onChange={setName} />
          </label>
          <label>
            <span>{copy.description}</span>
            <Textarea value={description} autosize={{ minRows: 2, maxRows: 5 }} onChange={setDescription} />
          </label>
          {error === undefined ? null : <div className="cxr-danger" role="alert">{error}</div>}
        </div>
      </HostEditorDialog>
      <HostEditorDialog
        visible={removing !== undefined}
        header={copy.remove}
        confirmBtn={{ content: copy.remove, theme: 'danger' }}
        cancelBtn={copy.cancel}
        showOwner={false}
        onClose={() => setRemovingUrl(undefined)}
        onConfirm={remove}
      >
        <div className="cxr-dialog-form">
          <strong>{removing?.name}</strong>
          <p>{copy.removeDescription}</p>
          <code>{removing?.url}</code>
        </div>
      </HostEditorDialog>
      <HostEditorDialog
        visible={sourceError !== undefined}
        header={copy.errorTitle}
        confirmBtn={{ content: copy.retry, disabled: failed?.refreshing === true }}
        cancelBtn={copy.close}
        showOwner={false}
        onClose={() => setSourceError(undefined)}
        onConfirm={retry}
      >
        <div className="cxr-dialog-form">
          <strong>{failed?.name}</strong>
          <code>{failed?.url}</code>
          <div className="cxr-danger" role="alert">{sourceError?.message}</div>
        </div>
      </HostEditorDialog>
    </>
  )
}
