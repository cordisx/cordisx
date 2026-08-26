import { useState } from 'react'
import { Button, Dialog, Input, Switch } from 'tdesign-react'
import { OFFICIAL_MARKETPLACE_SOURCE, normalizeMarketplaceSource, projectMarketplaceSource, type MarketplaceModel } from '../../marketplace.js'
import { DeleteIcon } from 'tdesign-icons-react'
import { useMarketplaceSnapshot } from '../model/marketplace-store.js'

export function MarketplaceSourcesPage({ marketplace, locale }: { readonly marketplace: MarketplaceModel; readonly locale: string }) {
  const snapshot = useMarketplaceSnapshot(marketplace)
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const save = async () => {
    try {
      const normalized = normalizeMarketplaceSource(url.trim())
      await marketplace.upsertSource({ url: normalized, enabled: true, ...(name.trim() === '' ? {} : { local: { name: name.trim() } }) })
      setVisible(false); setUrl(''); setName(''); setError(undefined)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <section className="cxr-page">
    <header className="cxr-page-head"><div><h3>插件来源</h3><p>来源记录保存在当前 Host profile；官方来源不可删除。</p></div><Button theme="primary" onClick={() => setVisible(true)}>添加来源</Button></header>
    <div className="cxr-list">{snapshot.sourceRecords.map(record => {
      const state = snapshot.sourceStates.find(item => item.url === record.url)
      const projection = projectMarketplaceSource(state ?? { url: record.url, enabled: record.enabled, official: record.url === OFFICIAL_MARKETPLACE_SOURCE, status: 'loading', phase: 'idle', stale: false, revalidating: false, attempts: 0, ...(record.local === undefined ? {} : { local: record.local }) }, locale)
      return <section className="cxr-card" key={record.url} data-marketplace-source={record.url}><span className="cxr-card-body"><span className="cxr-card-title">{projection.name}</span><span className="cxr-card-description">{projection.description ?? state?.error}</span><code className="cxr-card-code">{record.url}</code></span><Switch value={record.enabled} aria-label={`启用 ${projection.name}`} onChange={enabled => void marketplace.setSourceEnabled(record.url, enabled)} /><Button shape="square" variant="text" theme="danger" icon={<DeleteIcon />} aria-label={`删除 ${projection.name}`} disabled={record.url === OFFICIAL_MARKETPLACE_SOURCE} onClick={() => void marketplace.removeSource(record.url)} /></section>
    })}</div>
    <Dialog visible={visible} header="添加来源" confirmBtn="保存" cancelBtn="取消" onClose={() => setVisible(false)} onConfirm={() => void save()}>
      <div className="cxr-dialog-form"><label><span>来源地址</span><Input value={url} placeholder="https://…/marketplace.json" onChange={setUrl} /></label><label><span>本地名称（可选）</span><Input value={name} onChange={setName} /></label>{error === undefined ? null : <div className="cxr-danger" role="alert">{error}</div>}</div>
    </Dialog>
  </section>
}
