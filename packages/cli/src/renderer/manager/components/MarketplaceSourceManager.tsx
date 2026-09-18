import { useState } from 'react'
import { Input, Switch, Textarea } from 'tdesign-react'
import { HostEditorDialog } from '../../dialogs/internal.js'
import { IconButton } from '../../host-ui/IconButton.js'

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
    edit: '编辑来源',
    save: '保存',
    cancel: '取消',
    url: '来源地址',
    urlPlaceholder: 'https://…/marketplace.json',
    name: '本地名称（可选）',
    description: '本地描述（可选）',
    enabled: '启用',
    disabled: '停用',
    refresh: '刷新来源',
    copy: '复制来源地址',
    remove: '删除来源',
    empty: '尚未配置插件来源',
  },
  en: {
    add: 'Add source',
    edit: 'Edit source',
    save: 'Save',
    cancel: 'Cancel',
    url: 'Source URL',
    urlPlaceholder: 'https://…/marketplace.json',
    name: 'Local name (optional)',
    description: 'Local description (optional)',
    enabled: 'Enable',
    disabled: 'Disable',
    refresh: 'Refresh source',
    copy: 'Copy source URL',
    remove: 'Remove source',
    empty: 'No Marketplace sources are configured',
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
  const [editing, setEditing] = useState<MarketplaceSourceView | 'new'>()
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
  return (
    <>
      <div className="cxr-source-toolbar">
        <IconButton icon="marketplace-source-add" label={copy.add} onClick={() => open()} />
      </div>
      <div className="cxr-list" data-marketplace-source-list="true">
        {sources.map(source => {
          const busy = busyUrl === source.url
          return (
            <section className="cxr-card cxr-source-row" key={source.url} data-marketplace-source={source.url}>
              <span className="cxr-card-body">
                <span className="cxr-card-title">{source.name}</span>
                <span className="cxr-card-description">{source.description ?? source.error}</span>
                <code className="cxr-card-code">{source.url}</code>
              </span>
              <span className="cxr-source-state">{source.enabled ? copy.enabled : copy.disabled}</span>
              <Switch
                value={source.enabled}
                disabled={busy}
                aria-label={`${source.enabled ? copy.disabled : copy.enabled} ${source.name}`}
                onChange={enabled => void onSetEnabled(source.url, enabled)}
              />
              <span className="cxr-source-actions">
                <IconButton
                  icon="marketplace-source-edit"
                  label={`${copy.edit}: ${source.name}`}
                  disabled={busy}
                  onClick={() => open(source)}
                />
                <IconButton
                  icon="reload-plugin"
                  label={`${copy.refresh}: ${source.name}`}
                  loading={source.refreshing}
                  disabled={busy}
                  onClick={() => void onRefresh(source.url)}
                />
                <IconButton
                  icon="marketplace-source-copy"
                  label={`${copy.copy}: ${source.name}`}
                  disabled={busy || window.navigator.clipboard === undefined}
                  onClick={() => void window.navigator.clipboard.writeText(source.url)}
                />
                <IconButton
                  icon="delete"
                  label={`${copy.remove}: ${source.name}`}
                  disabled={busy || !source.removable}
                  theme="danger"
                  onClick={() => void onRemove(source.url)}
                />
              </span>
            </section>
          )
        })}
        {sources.length === 0 ? <div className="cxr-empty">{copy.empty}</div> : null}
      </div>
      <HostEditorDialog
        visible={editing !== undefined}
        header={editing === 'new' ? copy.add : copy.edit}
        confirmBtn={copy.save}
        cancelBtn={copy.cancel}
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
    </>
  )
}
