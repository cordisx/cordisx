import { type CordisXPluginConsoleEntryV1, type CordisXPluginConsolePageV1 } from '../../contracts.js'
import { resolveHostTheme } from '.././host-theme.js'
import {
  pluginConsoleEntryCopyText,
  PluginConsoleLunaEntryProjection,
  serializePluginConsoleExport,
} from './console-projection.js'
import { create } from './dom.js'
import type { ManagerConsoleState } from './interaction-state.js'

export interface ConsoleDependencies {
  consoleScrollStates: Map<string, { follow: boolean; scrollTop: number }>
  document: Document
  renderContent: () => void
  lunaConsoleMounts: Set<{ readonly destroy: () => void; readonly setTheme: (theme: 'dark' | 'light') => void }>
  consoleState: Pick<ManagerConsoleState, 'selectedConsoleEntry'>
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createConsole(dependencies: ConsoleDependencies) {
  const mountLunaConsole = (
    container: HTMLElement,
    projections: readonly PluginConsoleLunaEntryProjection[],
    pluginId: string,
    latest: HTMLButtonElement,
  ): void => {
    const state = dependencies.consoleScrollStates.get(pluginId) ?? { follow: true, scrollTop: 0 }
    dependencies.consoleScrollStates.set(pluginId, state)
    let desiredTheme = resolveHostTheme(dependencies.document).theme
    interface LunaLogRecord {
      readonly container: HTMLElement
      copy(): void
      select(): void
    }
    interface LunaConsoleViewer {
      destroy(): void
      setOption(name: string, value: unknown): void
      renderViewport(options?: unknown): void
      on(name: string, listener: (record: LunaLogRecord) => void): void
      insert(options: {
        readonly type: CordisXPluginConsoleEntryV1['method']
        readonly args: readonly unknown[]
        readonly header: { readonly time: string; readonly from: string }
      }): void
    }
    let viewer: LunaConsoleViewer | undefined
    let resizeObserver: ResizeObserver | undefined
    let destroyed = false
    const entriesByRecord = new WeakMap<LunaLogRecord, CordisXPluginConsoleEntryV1>()
    let pendingEntry: CordisXPluginConsoleEntryV1 | undefined
    const isAtBottom = (): boolean => container.scrollHeight - container.clientHeight - container.scrollTop <= 4
    const syncLatest = (): void => {
      latest.hidden = state.follow || container.scrollHeight <= container.clientHeight + 4
    }
    const scrollToLatest = (): void => {
      state.follow = true
      container.scrollTop = container.scrollHeight
      state.scrollTop = container.scrollTop
      syncLatest()
    }
    const onScroll = (): void => {
      state.scrollTop = container.scrollTop
      state.follow = isAtBottom()
      syncLatest()
    }
    const focusReplacement = (): void =>
      queueMicrotask(() => {
        ;[...dependencies.document.querySelectorAll<HTMLElement>('[data-plugin-console]')]
          .find(item => item.dataset.pluginConsole === pluginId)?.focus()
      })
    const selectRelative = (offset: number): void => {
      if (projections.length === 0) return
      const current = projections.findIndex(item =>
        item.entry.entryId === dependencies.consoleState.selectedConsoleEntry
      )
      const next = Math.max(
        0,
        Math.min(projections.length - 1, (current < 0 ? (offset > 0 ? -1 : projections.length) : current) + offset),
      )
      dependencies.consoleState.selectedConsoleEntry = projections[next]?.entry.entryId
      state.scrollTop = container.scrollTop
      dependencies.renderContent()
      focusReplacement()
    }
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        selectRelative(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (
        (event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'c'
        && dependencies.consoleState.selectedConsoleEntry !== undefined
      ) {
        const selected = projections.find(item => item.entry.entryId === dependencies.consoleState.selectedConsoleEntry)
          ?.entry
        if (selected !== undefined) {
          event.preventDefault()
          void copyConsoleText(pluginConsoleEntryCopyText(selected)).catch(() => undefined)
        }
      }
    }
    const onLatest = (): void => scrollToLatest()
    container.tabIndex = 0
    container.setAttribute('aria-label', 'Luna Console 插件控制台正文；使用上下方向键选择记录')
    container.addEventListener('scroll', onScroll)
    container.addEventListener('keydown', onKeydown)
    latest.addEventListener('click', onLatest)
    const restoreScroll = (): void => {
      if (destroyed) return
      if (state.follow) container.scrollTop = container.scrollHeight
      else container.scrollTop = Math.min(state.scrollTop, Math.max(0, container.scrollHeight - container.clientHeight))
      state.scrollTop = container.scrollTop
      syncLatest()
    }
    const refreshLunaViewport = (): void => {
      viewer?.renderViewport()
      const view = dependencies.document.defaultView
      if (view?.requestAnimationFrame !== undefined) {
        view.requestAnimationFrame(() => {
          if (destroyed) return
          viewer?.renderViewport()
          restoreScroll()
        })
      } else {queueMicrotask(() => {
          if (!destroyed) {
            viewer?.renderViewport()
            restoreScroll()
          }
        })}
    }
    const mount = {
      destroy: (): void => {
        if (destroyed) return
        destroyed = true
        resizeObserver?.disconnect()
        container.removeEventListener('scroll', onScroll)
        container.removeEventListener('keydown', onKeydown)
        latest.removeEventListener('click', onLatest)
        viewer?.destroy()
        dependencies.lunaConsoleMounts.delete(mount)
      },
      setTheme: (theme: 'dark' | 'light'): void => {
        desiredTheme = theme
        viewer?.setOption('theme', theme)
      },
    }
    dependencies.lunaConsoleMounts.add(mount)
    void import('luna-console').then(module => {
      if (destroyed || !container.isConnected) return
      const Constructor = module.default as unknown as new(
        target: HTMLElement,
        options?: {
          readonly asyncRender?: boolean
          readonly showHeader?: boolean
          readonly accessGetter?: boolean
          readonly unenumerable?: boolean
          readonly lazyEvaluation?: boolean
          readonly maxNum?: number
          readonly theme?: 'dark' | 'light'
        },
      ) => LunaConsoleViewer
      viewer = new Constructor(container, {
        asyncRender: false,
        showHeader: true,
        accessGetter: false,
        unenumerable: true,
        lazyEvaluation: false,
        maxNum: 2000,
        theme: desiredTheme,
      })
      viewer.on('insert', (record) => {
        if (pendingEntry === undefined) return
        entriesByRecord.set(record, pendingEntry)
        record.container.dataset.consoleEntry = pendingEntry.entryId
        record.container.dataset.consoleMethod = pendingEntry.method
        record.container.dataset.consoleSource = pendingEntry.source
      })
      viewer.on('select', (record) => {
        const entry = entriesByRecord.get(record)
        if (entry === undefined || dependencies.consoleState.selectedConsoleEntry === entry.entryId) return
        dependencies.consoleState.selectedConsoleEntry = entry.entryId
        state.scrollTop = container.scrollTop
        dependencies.renderContent()
      })
      for (const projection of projections) {
        pendingEntry = projection.entry
        viewer.insert({ type: projection.type, args: projection.args, header: projection.header })
      }
      pendingEntry = undefined
      // Luna virtualizes against the dimensions present at construction. A tab
      // can be connected before it is visible, so refresh after inserting the
      // first records and again on the next frame.
      refreshLunaViewport()
      const ResizeObserverConstructor = dependencies.document.defaultView?.ResizeObserver
      if (ResizeObserverConstructor !== undefined) {
        resizeObserver = new ResizeObserverConstructor(() => {
          viewer?.renderViewport()
          if (state.follow) scrollToLatest()
          else syncLatest()
        })
        resizeObserver.observe(container)
        const space = container.querySelector<HTMLElement>('.luna-console-logs-space')
        if (space !== null) resizeObserver.observe(space)
      }
      refreshLunaViewport()
    }).catch((error: unknown) => {
      if (destroyed) return
      container.classList.remove('cxm-console-luna')
      const reason = error instanceof Error ? error.message : 'unknown renderer error'
      container.replaceChildren(
        create(dependencies.document, 'div', 'cxm-console-empty', `Luna Console 正文组件加载失败：${reason}`),
      )
    })
  }

  const copyConsoleText = async (value: string): Promise<void> => {
    const clipboard = dependencies.document.defaultView?.navigator.clipboard
    if (clipboard !== undefined) {
      await clipboard.writeText(value)
      return
    }
    const textarea = create(dependencies.document, 'textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    ;(dependencies.document.body ?? dependencies.document.documentElement).append(textarea)
    textarea.select()
    dependencies.document.execCommand('copy')
    textarea.remove()
  }

  const exportPluginConsole = (pluginId: string, page: CordisXPluginConsolePageV1): void => {
    const view = dependencies.document.defaultView
    if (view === null || typeof view.Blob !== 'function' || typeof view.URL.createObjectURL !== 'function') return
    const payload = serializePluginConsoleExport(page)
    const url = view.URL.createObjectURL(new view.Blob([payload], { type: 'application/json' }))
    const link = create(dependencies.document, 'a')
    link.href = url
    link.download = `${pluginId}-logs.json`
    link.hidden = true
    dependencies.document.body.append(link)
    link.click()
    link.remove()
    view.setTimeout(() => view.URL.revokeObjectURL(url), 0)
  }
  return { mountLunaConsole, copyConsoleText, exportPluginConsole }
}
