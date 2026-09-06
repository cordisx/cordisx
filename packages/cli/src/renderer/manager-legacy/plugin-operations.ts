import type { CordisXConfigFieldSnapshot } from '../../contracts.js'
import { type CordisXPluginLifecycleOperationV1, type CordisXPluginLifecycleResultV1 } from '../../contracts.js'
import { HostFormAdapter } from '.././host-form.js'
import { createManagerIcon, type ManagerIconToken } from '.././icons.js'
import {
  setTDesignDisabled,
  setTDesignProps,
  type TDesignButtonElement,
  type TDesignElement,
} from '.././tdesign-form.js'
import {
  requestPluginAuthorization,
  requestPluginAuthorizationV2,
  requestPluginAuthorizationV4,
} from './authorization.js'
import { create } from './dom.js'
import type { ManagerContentState, ManagerMenuState } from './interaction-state.js'
import { ManagerModel, ManagerPluginSnapshot, ManagerPluginStatus, ManagerSnapshot } from './model.js'
import { safeStorage } from './widgets.js'

export interface PluginOperationsDependencies {
  model: ManagerModel
  document: Document
  disposeHostCollections: () => void
  resetManagerContent: () => Promise<void>
  modal: HTMLDivElement
  trigger: HTMLButtonElement
  forms: HostFormAdapter
  mountPortal: <Element extends HTMLElement>(portal: Element) => () => void
  managerIconAction: (
    icon: ManagerIconToken,
    label: string,
    options?: {
      readonly className?: string
      readonly disabled?: boolean
      readonly description?: string
      readonly pressed?: boolean
    },
  ) => HTMLButtonElement
  lifecycleInstallBusy: boolean
  operationError: string | undefined
  renderContent: () => void
  lifecycleBusy: Map<string, ManagerPluginStatus>
  contentState: Pick<ManagerContentState, 'managerContentMount' | 'managerContentMountId'>
  menuState: Pick<ManagerMenuState, 'pendingPluginMenuFocus'>
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createPluginOperations(dependencies: PluginOperationsDependencies) {
  const authorizeAndRestore = async (plugin: ManagerPluginSnapshot): Promise<void> => {
    const createPlanV2 = dependencies.model.permissionAuthorizationPlanV2
    const authorizeV2 = dependencies.model.authorizePluginV2
    const permissions = dependencies.model.snapshot().permissions.filter(item => (
      item.identity.source === plugin.source && item.identity.id === plugin.id
    ))
    const planV2 = createPlanV2?.(plugin.id)
    if (planV2 !== undefined) {
      if (authorizeV2 === undefined) throw new Error('插件 V2 授权服务当前不可用，未恢复插件')
      const decision = await requestPluginAuthorizationV2(dependencies.document, plugin, planV2, permissions)
      if (decision !== undefined) await authorizeV2(plugin.id, decision)
      return
    }
    const createPlan = dependencies.model.permissionAuthorizationPlan
    const authorize = dependencies.model.authorizePlugin
    if (createPlan === undefined || authorize === undefined) {
      throw new Error('插件授权服务当前不可用，未恢复插件')
    }
    const plan = createPlan(plugin.id)
    const decision = await requestPluginAuthorization(dependencies.document, plugin, plan, permissions)
    if (decision === undefined) return
    await authorize(plugin.id, decision)
  }

  const hideForExternalNavigation = (): void => {
    dependencies.disposeHostCollections()
    if (
      dependencies.contentState.managerContentMount !== undefined
      || dependencies.contentState.managerContentMountId !== undefined
    ) {
      void dependencies.resetManagerContent().catch(() => {})
    }
    dependencies.modal.hidden = true
    dependencies.trigger.setAttribute('aria-expanded', 'false')
  }

  const configureExternalLink = <T extends HTMLAnchorElement>(link: T, href: string): T => {
    link.href = href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.addEventListener('click', hideForExternalNavigation)
    return link
  }

  const documentationLink = (label: string, href: string): HTMLAnchorElement => {
    const link = configureExternalLink(create(dependencies.document, 'a', 'cxm-action'), href)
    link.append(
      create(dependencies.document, 'span', undefined, label),
      createManagerIcon(dependencies.document, 'external-link', 'cxm-action-icon'),
    )
    return link
  }

  const favoriteStorageKey = (snapshot: ManagerSnapshot): string => (
    `cordisx.manager.favoritePlugins.v1:${snapshot.pluginLifecycle?.profileId ?? 'development'}`
  )

  const favoritePlugins = (snapshot: ManagerSnapshot): Set<string> => {
    try {
      const value = safeStorage(dependencies.document.defaultView)?.getItem(favoriteStorageKey(snapshot))
      if (value === null || value === undefined) return new Set()
      const parsed = JSON.parse(value) as unknown
      return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
    } catch {
      return new Set()
    }
  }

  const setFavorite = (snapshot: ManagerSnapshot, pluginId: string, favorite: boolean): void => {
    const next = favoritePlugins(snapshot)
    if (favorite) next.add(pluginId)
    else next.delete(pluginId)
    try {
      safeStorage(dependencies.document.defaultView)?.setItem(
        favoriteStorageKey(snapshot),
        JSON.stringify([...next].sort()),
      )
    } catch {}
  }

  const requestLifecycleConfirmation = (
    title: string,
    description: string,
    affectedPluginIds: readonly string[],
    confirmLabel: string,
    danger = false,
  ): Promise<boolean> =>
    new Promise(resolve => {
      const overlay = create(dependencies.document, 'div', 'cxm-lifecycle-overlay')
      let unmountOverlay = (): void => {}
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      const panel = create(dependencies.document, 'div', 'cxm-lifecycle-dialog')
      const heading = create(dependencies.document, 'h2', undefined, title)
      panel.append(heading, create(dependencies.document, 'p', undefined, description))
      if (affectedPluginIds.length > 0) {
        panel.append(
          create(dependencies.document, 'div', 'cxm-lifecycle-impact', `影响插件：${affectedPluginIds.join('、')}`),
        )
      }
      const actions = create(dependencies.document, 'div', 'cxm-lifecycle-actions')
      const finish = (confirmed: boolean): void => {
        unmountOverlay()
        resolve(confirmed)
      }
      panel.classList.add('cxf-scope')
      const cancel = dependencies.forms.button('取消')
      cancel.addEventListener('click', () => finish(false), { once: true })
      const confirm = dependencies.forms.button(confirmLabel, {
        variant: danger ? 'default' : 'primary',
        tone: danger ? 'danger' : 'default',
      })
      confirm.addEventListener('click', () => finish(true), { once: true })
      overlay.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        finish(false)
      })
      actions.append(cancel, confirm)
      panel.append(actions)
      overlay.append(panel)
      unmountOverlay = dependencies.mountPortal(overlay)
      cancel.focus()
    })

  const requestLocalPackageDirectory = (invoker?: HTMLElement): Promise<string | undefined> =>
    new Promise(resolve => {
      const overlay = create(dependencies.document, 'div', 'cxm-lifecycle-overlay')
      const HTMLElementCtor = dependencies.document.defaultView?.HTMLElement
      const returnFocus = invoker
        ?? (HTMLElementCtor !== undefined && dependencies.document.activeElement instanceof HTMLElementCtor
          ? dependencies.document.activeElement
          : undefined)
      let unmountOverlay = (): void => {}
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      const panel = create(dependencies.document, 'div', 'cxm-lifecycle-dialog cxm-local-import-dialog')
      panel.classList.add('cxf-scope')
      const header = create(dependencies.document, 'div', 'cxm-lifecycle-header')
      const heading = create(dependencies.document, 'h2', undefined, '导入本地插件')
      heading.id = 'cxm-local-package-directory-heading'
      overlay.setAttribute('aria-labelledby', heading.id)
      const close = dependencies.managerIconAction('close', '关闭')
      close.dataset.importLocalClose = 'true'
      header.append(heading, close)
      // The Host overlay title plus the labelled directory control already
      // explains this bounded operation. Do not add a second title/CTA shell.
      panel.append(header)
      const form = dependencies.forms.form('local-package-directory')
      form.classList.add('cxm-local-import-form')
      const field = create(dependencies.document, 'div', 'cxm-local-import-field')
      const label = create(dependencies.document, 'label', 'cxf-label', '插件目录')
      label.id = 'cxm-local-package-directory-label'
      label.htmlFor = 'cxm-local-package-directory'
      const error = create(dependencies.document, 'p', 'cxm-local-import-error')
      error.id = 'cxm-local-package-directory-error'
      error.setAttribute('role', 'alert')
      error.hidden = true
      let pathValue = ''
      let inspect: TDesignButtonElement | undefined
      const validPath = (value: string): boolean => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
      const updatePath = (value: string): void => {
        pathValue = value.trim()
        const message = pathValue === '' ? undefined : validPath(pathValue) ? undefined : '请选择目录或输入绝对路径'
        error.textContent = message ?? ''
        error.hidden = message === undefined
        field.dataset.invalid = String(!error.hidden)
        if (error.hidden) control?.focusTarget?.removeAttribute('aria-invalid')
        else control?.focusTarget?.setAttribute('aria-invalid', 'true')
        if (inspect !== undefined) setTDesignDisabled(inspect, !validPath(pathValue))
      }
      const pathField: CordisXConfigFieldSnapshot = {
        namespace: 'cordisx.host',
        path: ['localPackageDirectory'],
        type: 'string',
        role: 'directory',
        value: '',
        disabled: false,
        required: true,
      }
      const control = dependencies.forms.control(pathField, 'cxm-local-package-directory', value => {
        updatePath(typeof value === 'string' ? value : '')
      })
      control.focusTarget?.setAttribute('aria-labelledby', label.id)
      control.focusTarget?.setAttribute('aria-describedby', error.id)
      control.focusTarget?.setAttribute('data-import-local-path', '')
      const directoryControl = create(dependencies.document, 'div', 'cxm-directory-control')
      const picker = create(dependencies.document, 'input', 'cxm-visually-hidden')
      picker.type = 'file'
      picker.tabIndex = -1
      picker.setAttribute('webkitdirectory', '')
      picker.setAttribute('directory', '')
      picker.dataset.importLocalPicker = 'true'
      const choose = dependencies.managerIconAction('import-plugin', '选择插件目录', {
        className: 'cxm-directory-picker',
      })
      choose.dataset.importLocalChoose = 'true'
      choose.addEventListener('click', () => picker.click())
      picker.addEventListener('change', () => {
        const file = picker.files?.[0] as (File & { readonly path?: string }) | undefined
        const filePath = file?.path
        const relative = file?.webkitRelativePath
        if (filePath === undefined || relative === undefined || relative === '') {
          pathValue = ''
          setTDesignProps(control.focusTarget as TDesignElement, { value: '', defaultValue: '' })
          error.textContent = '当前环境无法读取目录路径，请粘贴绝对路径'
          error.hidden = false
          field.dataset.invalid = 'true'
          control.focusTarget?.setAttribute('aria-invalid', 'true')
          if (inspect !== undefined) setTDesignDisabled(inspect, true)
          control.focusTarget?.focus()
          return
        }
        const separator = filePath.includes('\\') ? '\\' : '/'
        const relativePath = relative.replaceAll('/', separator)
        const rootName = relative.split('/')[0] ?? ''
        const root = filePath.endsWith(relativePath)
          ? `${filePath.slice(0, -relativePath.length)}${rootName}`
          : filePath.slice(0, Math.max(filePath.lastIndexOf(separator), 0))
        setTDesignProps(control.focusTarget as TDesignElement, { value: root })
        ;(control.focusTarget as TDesignElement & { onChange?: (value: string) => void }).onChange?.(root)
        updatePath(root)
        control.focusTarget?.focus()
      })
      directoryControl.append(control.root, choose)
      field.append(label, directoryControl, picker, error)
      const actions = create(dependencies.document, 'div', 'cxf-actions cxm-local-import-actions')
      const restoreInvokerFocus = (): void => {
        const currentInvoker = invoker?.isConnected === true
          ? invoker
          : dependencies.document.querySelector<HTMLElement>('[data-import-local-plugin]')
        ;(currentInvoker ?? returnFocus)?.focus({ preventScroll: true })
      }
      const finish = (value?: string): void => {
        unmountOverlay()
        restoreInvokerFocus()
        resolve(value)
        dependencies.document.defaultView?.setTimeout(() => {
          restoreInvokerFocus()
        }, 0)
      }
      close.addEventListener('click', () => finish(), { once: true })
      const cancel = dependencies.forms.button('取消')
      cancel.addEventListener('click', () => finish(), { once: true })
      inspect = dependencies.forms.button('检查并导入', { type: 'submit', variant: 'primary' })
      setTDesignDisabled(inspect, true)
      inspect.setAttribute('data-import-local-submit', '')
      form.addEventListener('submit', event => {
        event.preventDefault()
        if (!validPath(pathValue)) {
          error.textContent = pathValue === '' ? '请选择插件目录' : '请选择目录或输入绝对路径'
          error.hidden = false
          field.dataset.invalid = 'true'
          control.focusTarget?.setAttribute('aria-invalid', 'true')
          control.focusTarget?.focus()
          return
        }
        finish(pathValue)
      })
      form.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish()
        }
      })
      actions.append(cancel, inspect)
      form.append(field, actions)
      panel.append(form)
      overlay.append(panel)
      unmountOverlay = dependencies.mountPortal(overlay)
      control.focusTarget?.focus()
    })

  const lifecycleFailure = (result: CordisXPluginLifecycleResultV1): Error | undefined => {
    if (result.outcome === 'applied' || result.outcome === 'planned') return undefined
    return new Error(result.error?.message ?? `插件操作未完成：${result.outcome}`)
  }

  const requestLifecycle = async (
    operation: CordisXPluginLifecycleOperationV1,
  ): Promise<CordisXPluginLifecycleResultV1> => {
    if (dependencies.model.requestPluginLifecycle === undefined) throw new Error('当前 launcher 未提供插件生命周期服务')
    const result = await dependencies.model.requestPluginLifecycle(operation)
    const failure = lifecycleFailure(result)
    if (failure !== undefined) throw failure
    return result
  }

  const runLocalPackageInstall = async (invoker?: HTMLElement): Promise<void> => {
    const sourceDirectory = await requestLocalPackageDirectory(invoker)
    if (sourceDirectory === undefined) return
    dependencies.lifecycleInstallBusy = true
    dependencies.operationError = undefined
    dependencies.renderContent()
    let packageId: string | undefined
    try {
      const inspection = await requestLifecycle({ kind: 'inspect-local', sourceDirectory })
      if (
        inspection.outcome !== 'planned'
        || inspection.candidateId === undefined
        || inspection.package === undefined
        || (inspection.operation !== 'install' && inspection.operation !== 'update')
      ) {
        throw new Error('本地包检查没有返回可应用的候选版本')
      }
      packageId = inspection.package.id
      dependencies.lifecycleBusy.set(packageId, inspection.operation === 'install' ? 'installing' : 'updating')
      dependencies.renderContent()
      const reviewTarget = {
        kind: 'candidate',
        candidateId: inspection.candidateId,
      } as const
      const planV4 = await dependencies.model.permissionLifecycleReviewPlanV4?.(reviewTarget)
      const planV2 = planV4 === undefined
        ? await dependencies.model.permissionLifecycleReviewPlanV2?.(reviewTarget)
        : undefined
      let applied: CordisXPluginLifecycleResultV1
      if (planV4 !== undefined) {
        if (dependencies.model.applyPermissionLifecycleReviewV4 === undefined) throw new Error('安装权限 V4 服务不可用')
        const decision = await requestPluginAuthorizationV4(
          dependencies.document,
          {
            id: inspection.package.id,
            source: planV4.identity.source,
            name: inspection.package.name ?? inspection.package.id,
          },
          planV4,
          dependencies.model.snapshot().permissions.filter(item => (
            item.identity.id === inspection.package!.id && item.identity.source === planV4.identity.source
          )),
        )
        if (decision === undefined) return
        applied = await dependencies.model.applyPermissionLifecycleReviewV4(decision)
      } else if (planV2 !== undefined) {
        if (dependencies.model.applyPermissionLifecycleReviewV2 === undefined) throw new Error('安装权限 V2 服务不可用')
        const decision = await requestPluginAuthorizationV2(
          dependencies.document,
          {
            id: inspection.package.id,
            source: planV2.identity.source,
            name: inspection.package.name ?? inspection.package.id,
          },
          planV2,
          dependencies.model.snapshot().permissions.filter(item => (
            item.identity.id === inspection.package!.id && item.identity.source === planV2.identity.source
          )),
        )
        if (decision === undefined) return
        applied = await dependencies.model.applyPermissionLifecycleReviewV2(decision)
      } else {
        if (inspection.authorizationPlan === undefined) throw new Error('本地包检查没有返回可应用的授权计划')
        const decision = await requestPluginAuthorization(
          dependencies.document,
          { id: inspection.package.id, name: inspection.package.name ?? inspection.package.id },
          inspection.authorizationPlan,
          dependencies.model.snapshot().permissions.filter(item => (
            item.identity.id === inspection.package!.id
            && item.identity.source === inspection.authorizationPlan!.identity.source
          )),
        )
        if (decision === undefined) return
        applied = await requestLifecycle({
          kind: inspection.operation,
          candidateId: inspection.candidateId,
          authorizationDecision: decision,
        })
      }
      if (applied.outcome !== 'applied') throw new Error('插件候选版本没有激活')
    } catch (error) {
      dependencies.operationError = error instanceof Error ? error.message : String(error)
    } finally {
      dependencies.lifecycleInstallBusy = false
      if (packageId !== undefined) dependencies.lifecycleBusy.delete(packageId)
      dependencies.renderContent()
    }
  }

  const runPluginLifecycle = async (
    snapshot: ManagerSnapshot,
    plugin: ManagerPluginSnapshot,
    operation: 'enable' | 'disable' | 'reload' | 'uninstall',
    restoreMenuFocus = false,
  ): Promise<void> => {
    const busyStatus: Readonly<Record<typeof operation, ManagerPluginStatus>> = {
      enable: 'enabling',
      disable: 'disabling',
      reload: 'reloading',
      uninstall: 'uninstalling',
    }
    dependencies.lifecycleBusy.set(plugin.id, busyStatus[operation])
    dependencies.operationError = undefined
    if (restoreMenuFocus) dependencies.menuState.pendingPluginMenuFocus = plugin.id
    dependencies.renderContent()
    try {
      if (operation === 'reload') {
        const result = await requestLifecycle({ kind: 'reload', pluginId: plugin.id })
        if (result.outcome !== 'applied') throw new Error('插件没有完成重载')
        return
      }
      if (operation === 'enable') {
        const plan = await requestLifecycle({ kind: 'enable', pluginId: plugin.id })
        if (plan.outcome === 'applied') return
        if (plan.outcome !== 'planned') throw new Error('插件启用计划不可用')
        const reviewTarget = { kind: 'enable', pluginId: plugin.id } as const
        const planV4 = await dependencies.model.permissionLifecycleReviewPlanV4?.(reviewTarget)
        const planV2 = planV4 === undefined
          ? await dependencies.model.permissionLifecycleReviewPlanV2?.(reviewTarget)
          : undefined
        let result: CordisXPluginLifecycleResultV1
        if (planV4 !== undefined) {
          if (dependencies.model.applyPermissionLifecycleReviewV4 === undefined) {
            throw new Error('启用权限 V4 服务不可用')
          }
          const decision = await requestPluginAuthorizationV4(
            dependencies.document,
            plugin,
            planV4,
            snapshot.permissions.filter(item =>
              item.identity.id === plugin.id && item.identity.source === plugin.source
            ),
          )
          if (decision === undefined) return
          result = await dependencies.model.applyPermissionLifecycleReviewV4(decision)
        } else if (planV2 !== undefined) {
          if (dependencies.model.applyPermissionLifecycleReviewV2 === undefined) {
            throw new Error('启用权限 V2 服务不可用')
          }
          const decision = await requestPluginAuthorizationV2(
            dependencies.document,
            plugin,
            planV2,
            snapshot.permissions.filter(item =>
              item.identity.id === plugin.id && item.identity.source === plugin.source
            ),
          )
          if (decision === undefined) return
          result = await dependencies.model.applyPermissionLifecycleReviewV2(decision)
        } else {
          if (plan.authorizationPlan === undefined) throw new Error('插件启用授权计划不可用')
          const decision = await requestPluginAuthorization(
            dependencies.document,
            plugin,
            plan.authorizationPlan,
            snapshot.permissions.filter(item =>
              item.identity.id === plugin.id && item.identity.source === plugin.source
            ),
          )
          if (decision === undefined) return
          result = await requestLifecycle({ kind: 'enable', pluginId: plugin.id, authorizationDecision: decision })
        }
        if (result.outcome !== 'applied') throw new Error('插件没有完成启用')
        return
      }
      const planned = await requestLifecycle({ kind: operation, pluginId: plugin.id, impactToken: '' })
      if (planned.outcome !== 'planned' || planned.impactToken === undefined) throw new Error('插件影响计划不可用')
      const confirmed = await requestLifecycleConfirmation(
        operation === 'uninstall' ? `卸载 ${plugin.name}` : `禁用 ${plugin.name}`,
        operation === 'uninstall'
          ? '卸载会停止新调用，清理目标及其依赖闭包拥有的服务、页面、路由、命令、界面和订阅，并删除激活记录；包文件会延迟回收。'
          : '禁用会停止目标插件及依赖它的插件，但不会删除已安装包。',
        planned.affectedPluginIds,
        operation === 'uninstall' ? '确认卸载' : '确认禁用',
        operation === 'uninstall',
      )
      if (!confirmed) return
      const result = await requestLifecycle({ kind: operation, pluginId: plugin.id, impactToken: planned.impactToken })
      if (result.outcome !== 'applied') throw new Error(`插件没有完成${operation === 'uninstall' ? '卸载' : '禁用'}`)
    } catch (error) {
      dependencies.operationError = error instanceof Error ? error.message : String(error)
    } finally {
      dependencies.lifecycleBusy.delete(plugin.id)
      if (restoreMenuFocus) dependencies.menuState.pendingPluginMenuFocus = plugin.id
      dependencies.renderContent()
    }
  }

  const sharePlugin = async (plugin: ManagerPluginSnapshot): Promise<void> => {
    const url = publicCanonicalSource(plugin)
    if (url === undefined) return
    const navigator = dependencies.document.defaultView?.navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>
      clipboard?: { writeText(value: string): Promise<void> }
    }
    if (typeof navigator?.share === 'function') {
      await navigator.share({ title: plugin.name, url })
      return
    }
    if (typeof navigator?.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(url)
      return
    }
    dependencies.document.defaultView?.prompt('复制插件公开来源地址', url)
  }

  const publicCanonicalSource = (plugin: ManagerPluginSnapshot): string | undefined => {
    const source = plugin.package?.canonicalSource
    if (source === undefined) return undefined
    try {
      const url = new URL(source)
      return url.protocol === 'https:' ? url.href : undefined
    } catch {
      return undefined
    }
  }

  const packageOperationUnavailableReason = (
    snapshot: ManagerSnapshot,
    plugin: ManagerPluginSnapshot,
  ): string | undefined => {
    if (plugin.package === undefined) return '此插件未由 Package Store generation 管理'
    if (snapshot.pluginLifecycle?.operationsAvailable !== true) return '当前 launcher 未提供插件生命周期服务'
    if (dependencies.model.requestPluginLifecycle === undefined) return '当前 renderer 未连接插件生命周期服务'
    return undefined
  }

  const sourceUnavailableReason = (plugin: ManagerPluginSnapshot): string | undefined => {
    if (plugin.package?.canonicalSource === undefined) return 'Package Store 未提供公开 canonical HTTPS 来源'
    if (publicCanonicalSource(plugin) === undefined) return 'Package Store 的 canonical 来源不是公开 HTTPS 地址'
    return undefined
  }

  const openPluginSource = (plugin: ManagerPluginSnapshot): void => {
    const url = publicCanonicalSource(plugin)
    if (url === undefined) return
    dependencies.document.defaultView?.open(url, '_blank', 'noopener,noreferrer')
  }
  return {
    authorizeAndRestore,
    hideForExternalNavigation,
    configureExternalLink,
    favoritePlugins,
    setFavorite,
    runLocalPackageInstall,
    runPluginLifecycle,
    sharePlugin,
    packageOperationUnavailableReason,
    sourceUnavailableReason,
    openPluginSource,
  }
}
