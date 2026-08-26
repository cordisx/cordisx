import { useMemo, useState, useSyncExternalStore } from 'react'
import type { CordisXPluginConsoleEntryV1, CordisXPluginConsolePageV1 } from '../../../contracts.js'
import type { ManagerModel } from '../../manager.js'
import { managerCopy } from '../../ui-copy.js'
import { IconButton } from '../../host-ui/IconButton.js'
import { MoreMenu } from '../../host-ui/MoreMenu.js'
import { SelectField } from '../../host-ui/SelectField.js'
import { SearchField } from '../../host-ui/SearchField.js'
import { useAutoFollow } from '../../host-ui/useAutoFollow.js'
import { createPluginConsoleStore } from '../model/console-store.js'

export const PLUGIN_CONSOLE_REACT_STYLES = String.raw`
  .cxm-console-panel { display: grid; min-height: 0; flex: 1; grid-template-rows: auto minmax(0,1fr); gap: 0; overflow: hidden; }
  .cxm-console-controls { display: flex; min-width: 0; align-items: center; gap: 6px; margin: 0; padding: 0; }
  .cxm-console-controls .cxm-console-search { min-width: 9rem; height: 30px; flex: 1 1 13rem; gap: 6px; box-sizing: border-box; border: 1px solid #353a42; border-radius: 6px; padding: 0 8px; background: #15171a; color: #d8dce3; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-controls .cxm-console-search:focus-within { border-color: var(--cx-primary, #2f7cff); outline: 2px solid var(--cx-focus, rgba(47,124,255,.26)); outline-offset: 1px; }
  .cxm-console-controls .cxm-console-search input { width: 100%; height: 28px; }
  .cxm-console-filters { display: flex; min-width: 0; flex: 0 1 auto; align-items: center; gap: 5px; }
  .cxh-select-field { display: grid; min-width: 0; height: 30px; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 3px; box-sizing: border-box; border: 1px solid #353a42; border-radius: 6px; padding: 0 5px; background: #15171a; color: #aeb5c3; }
  .cxh-select-field .cxh-icon-seat, .cxh-select-field .cxm-material-icon { display: grid; place-items: center; width: 15px; height: 15px; }
  .cxh-select-field select { min-width: 0; width: 5.6rem; height: 28px; border: 0; outline: 0; background: transparent; color: #d8dce3; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxh-select-field.cxm-console-source select { width: 7rem; }
  .cxm-console-action-toolbar { position: relative; margin-left: auto; }
  .cxh-more-menu { position: relative; display: inline-flex; }
  .cxh-more-menu-popup { position: absolute; top: calc(100% + 5px); right: 0; z-index: 4; display: grid; min-width: 180px; padding: 4px; border: 1px solid var(--cx-border); border-radius: 8px; background: var(--cx-surface-raised); box-shadow: 0 12px 30px var(--cx-shadow); }
  .cxh-more-menu-popup button { display: flex; align-items: center; gap: 8px; min-height: 30px; border: 0; border-radius: 6px; padding: 5px 8px; background: transparent; color: var(--cx-text); cursor: pointer; text-align: left; font: 11px/1.3 system-ui, sans-serif; }
  .cxh-more-menu-popup button:hover:not(:disabled), .cxh-more-menu-popup button:focus-visible { background: var(--cx-hover); }
  .cxh-more-menu-popup button:disabled { opacity: .4; cursor: default; }
  .cxm-console-workspace { display: grid; min-width: 0; min-height: 0; grid-template-columns: minmax(0,1fr) auto; margin-top: 5px; gap: 6px; overflow: hidden; }
  .cxm-console-body { min-width: 0; min-height: 0; overflow: hidden; }
  .cxm-console-frame { width: 100%; height: 100%; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .cxm-console-row { display: flex; width: 100%; min-height: 23px; align-items: flex-start; border: 0; border-bottom: 1px solid rgba(255,255,255,.06); padding: 3px 10px; background: transparent; color: #cad0da; cursor: default; text-align: left; font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-row:hover, .cxm-console-row[aria-selected="true"] { background: rgba(199,204,212,.08); }
  .cxm-console-row[data-method="warn"] { color: #f6d98b; }
  .cxm-console-row[data-method="error"] { color: #f2a5ad; }
  .cxm-console-inspector { font-size: 11px; }
  @media (max-width: 900px) {
    .cxm-console-controls { flex-wrap: wrap; }
    .cxm-console-search { flex-basis: 100%; }
    .cxm-console-filters { flex: 1 1 auto; flex-wrap: wrap; }
    .cxm-console-action-toolbar { margin-left: 0; }
  }
`

export interface PluginConsolePanelProps {
  readonly model: ManagerModel
  readonly pluginId: string
  readonly pluginSource: string
  readonly locale: string
}

function fallbackPage(pluginId: string, source: string): CordisXPluginConsolePageV1 {
  return {
    contract: 'cordisx.plugin-console-page/v1',
    schemaVersion: 1,
    plugin: { source, pluginId },
    generation: 'manager-unavailable',
    generatedAt: Date.now(),
    partialObservability: true,
    entries: [],
  }
}

function copyText(entry: CordisXPluginConsoleEntryV1): string {
  const metadata = [new Date(entry.time).toISOString(), entry.method, entry.source, entry.kind, entry.correlationId]
    .filter((value): value is string => value !== undefined)
    .join(' · ')
  return `${metadata}\n${entry.message}${entry.args.length === 0 ? '' : `\n${entry.args.map(argument => argument.preview).join(' ')}`}`
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard !== undefined) await navigator.clipboard.writeText(value)
}

function exportLogs(pluginId: string, page: CordisXPluginConsolePageV1): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ ...page, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${pluginId}-logs.json`
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function PluginConsolePanel({ model, pluginId, pluginSource, locale }: PluginConsolePanelProps) {
  const store = useMemo(() => createPluginConsoleStore(model, pluginId, fallbackPage(pluginId, pluginSource)), [model, pluginId, pluginSource])
  const livePage = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [pausedPage, setPausedPage] = useState<CordisXPluginConsolePageV1>()
  const [query, setQuery] = useState('')
  const [method, setMethod] = useState('all')
  const [kind, setKind] = useState('all')
  const [source, setSource] = useState('all')
  const [selectedId, setSelectedId] = useState<string>()
  const page = pausedPage ?? livePage
  const sources = useMemo(() => [...new Set(page.entries.map(entry => entry.source))].sort(), [page])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = page.entries.filter(entry => (
    (method === 'all' || entry.method === method)
    && (kind === 'all' || kind === 'host-api' && (entry.kind === 'invocation' || entry.kind === 'permission') || entry.kind === kind)
    && (source === 'all' || entry.source === source)
    && (normalizedQuery === '' || `${entry.message} ${entry.source} ${entry.correlationId ?? ''} ${entry.args.map(argument => argument.preview).join(' ')}`.toLocaleLowerCase().includes(normalizedQuery))
  ))
  const selected = entries.find(entry => entry.entryId === selectedId)
  const follow = useAutoFollow<HTMLDivElement>(entries.length)
  const all = managerCopy(locale, 'console.all')
  const options = (values: readonly string[]) => values.map(value => ({ value, label: value === 'all' ? all : value }))
  const selectRelative = (offset: number) => {
    if (entries.length === 0) return
    const current = entries.findIndex(entry => entry.entryId === selectedId)
    const next = Math.max(0, Math.min(entries.length - 1, (current < 0 ? (offset > 0 ? -1 : entries.length) : current) + offset))
    setSelectedId(entries[next]?.entryId)
  }

  return (
    <div className="cxm-tab-panel cxm-console-panel" role="tabpanel" aria-label={managerCopy(locale, 'plugin-tab.logs')}>
      <div className="cxm-console-controls">
        <SearchField
          className="cxm-console-search"
          value={query}
          placeholder={managerCopy(locale, 'console.search-placeholder')}
          aria-label={managerCopy(locale, 'console.search-placeholder')}
          onChange={setQuery}
        />
        <div className="cxm-console-filters">
          <SelectField label={managerCopy(locale, 'console.level')} icon="configuration" value={method} options={options(['all', 'debug', 'log', 'info', 'warn', 'error'])} onChange={setMethod} />
          <SelectField label={managerCopy(locale, 'console.kind')} icon="contributions" value={kind} options={options(['all', 'host-api', 'console', 'lifecycle', 'diagnostic'])} onChange={setKind} />
          <SelectField className="cxm-console-source" label={managerCopy(locale, 'console.source')} icon="routes" value={source} options={options(['all', ...sources])} onChange={setSource} />
        </div>
        <div className="cxm-console-action-toolbar" role="toolbar" aria-label={managerCopy(locale, 'console.toolbar')}>
          <IconButton
            icon={pausedPage === undefined ? 'console-pause' : 'console-resume'}
            label={managerCopy(locale, pausedPage === undefined ? 'console.pause' : 'console.resume')}
            aria-pressed={pausedPage !== undefined}
            onClick={() => setPausedPage(value => value === undefined ? livePage : undefined)}
          />
          <IconButton
            icon="console-clear"
            label={managerCopy(locale, 'console.clear')}
            description={managerCopy(locale, 'console.irreversible')}
            disabled={page.entries.length === 0}
            onClick={() => { model.clearPluginConsole?.(pluginId); setSelectedId(undefined); setPausedPage(undefined) }}
          />
          <MoreMenu label={managerCopy(locale, 'console.toolbar')} items={[
            { id: 'copy', label: managerCopy(locale, 'console.copy'), icon: 'console-copy', disabled: selected === undefined, onSelect: () => { if (selected !== undefined) void writeClipboard(copyText(selected)) } },
            { id: 'export', label: managerCopy(locale, 'console.export'), icon: 'console-export', disabled: page.entries.length === 0, onSelect: () => exportLogs(pluginId, page) },
          ]} />
        </div>
      </div>
      <div className="cxm-console-workspace" data-inspector={selected === undefined ? undefined : 'true'}>
        <div className="cxm-console-body">
          <div
            ref={follow.ref}
            className="cxm-console-frame cxm-console-luna luna-console"
            data-plugin-console={pluginId}
            tabIndex={0}
            aria-label="插件控制台正文；使用上下方向键选择记录"
            onScroll={follow.onScroll}
            onKeyDown={event => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); selectRelative(event.key === 'ArrowDown' ? 1 : -1) }
              if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'c' && selected !== undefined) { event.preventDefault(); void writeClipboard(copyText(selected)) }
            }}
          >
            {entries.length === 0
              ? <div className="cxm-console-empty">{page.entries.length === 0 ? managerCopy(locale, 'console.empty') : managerCopy(locale, 'console.no-matches')}</div>
              : entries.map(entry => (
                <button
                  key={entry.entryId}
                  type="button"
                  className="cxm-console-row luna-console-log-container"
                  data-console-entry={entry.entryId}
                  data-method={entry.method}
                  data-source={entry.source}
                  aria-selected={entry.entryId === selectedId}
                  title={`${new Date(entry.time).toISOString()} · ${entry.source} · ${entry.kind}`}
                  onClick={() => setSelectedId(entry.entryId)}
                >{entry.message}</button>
              ))}
          </div>
        </div>
        {selected !== undefined && (
          <aside className="cxm-console-inspector" data-console-detail={selected.entryId}>
            <div className="cxm-console-inspector-head">
              <span>{managerCopy(locale, 'console.entry-details')}</span>
              <IconButton icon="close" label={managerCopy(locale, 'console.close-details')} onClick={() => setSelectedId(undefined)} />
            </div>
            <dl className="cxm-console-inspector-grid">
              {[
                [managerCopy(locale, 'console.field.timestamp'), new Date(selected.time).toISOString()],
                [managerCopy(locale, 'console.field.source'), selected.source],
                [managerCopy(locale, 'console.field.kind'), selected.kind],
                [managerCopy(locale, 'console.field.correlation'), selected.correlationId],
                [managerCopy(locale, 'console.field.status'), selected.status],
                [managerCopy(locale, 'console.field.duration'), selected.durationMs === undefined ? undefined : `${selected.durationMs.toFixed(1)}ms`],
              ].filter((item): item is [string, string] => item[1] !== undefined).map(([label, value]) => <span key={label}><dt>{label}</dt><dd>{value}</dd></span>)}
            </dl>
          </aside>
        )}
      </div>
    </div>
  )
}
