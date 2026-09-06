import type { CordisXConfigFieldSnapshot, CordisXJsonValue } from '../../contracts.js'
import type { HostServiceConfigDescriptor, HostServiceConfigMutation } from '../../launcher/service-config.js'
import type { ConfigMutationOperation, ConfigRendererMountHandle } from '.././configuration.js'
import {
  hostConfigApplyMessage,
  HostFormAdapter,
  selectHostFormPrimitive,
  validateHostFormValue,
} from '.././host-form.js'
import { setTDesignDisabled, type TDesignButtonElement } from '.././tdesign-form.js'
import { managerCopy, productLocale } from '.././ui-copy.js'
import { create } from './dom.js'
import { ManagerModel, ManagerPluginSnapshot } from './model.js'

export interface ConfigurationDependencies {
  model: ManagerModel
  document: Document
  forms: HostFormAdapter
  configDrafts: Map<
    string,
    {
      baseRevision: number
      readonly values: Map<string, unknown>
      readonly operations: Map<string, ConfigMutationOperation>
      readonly issues: Map<string, string>
      state: 'pristine' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'
      message?: string
    }
  >
  busyPluginId: string | undefined
  configRendererMounts: Set<ConfigRendererMountHandle>
  renderContent: () => void
  configFieldActionMenus: Set<{ dispose(): void }>
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createConfiguration(dependencies: ConfigurationDependencies) {
  const fieldLabel = (field: CordisXConfigFieldSnapshot): string => {
    const productLabel = field.label?.trim()
    if (productLabel !== undefined && productLabel !== '') return productLabel
    const value = String(field.path[field.path.length - 1] ?? 'value')
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replaceAll(/[._-]+/g, ' ')
      .replace(/^./, character => character.toUpperCase())
  }

  /**
   * Launcher services deliberately do not appear in Manager Settings.  The
   * owning plugin is the only product entry point, while this Host-rendered
   * adapter keeps schema projection, CAS, portal controls, and error policy
   * out of the plugin bundle.
   */
  const renderPluginServiceConfiguration = (plugin: ManagerPluginSnapshot, panel: HTMLElement): void => {
    if (plugin.id !== 'cli-proxy-api' || dependencies.model.listServiceConfigs === undefined) return
    const seat = create(dependencies.document, 'div', 'cxm-plugin-service-config')
    seat.dataset.pluginServiceConfig = plugin.id
    seat.append(
      dependencies.forms.empty(
        productLocale(dependencies.model.snapshot().localization.locale) === 'zh-CN'
          ? '正在读取 Provider 配置…'
          : 'Loading Provider configuration…',
      ),
    )
    panel.append(seat)

    const unavailable = (reason: unknown): string => {
      const code = reason instanceof Error ? reason.message : String(reason)
      if (code === 'permission-denied') {
        return productLocale(dependencies.model.snapshot().localization.locale) === 'zh-CN'
          ? '没有权限查看 Provider 配置。'
          : 'You do not have permission to view Provider configuration.'
      }
      return productLocale(dependencies.model.snapshot().localization.locale) === 'zh-CN'
        ? 'Provider 配置当前不可用。'
        : 'Provider configuration is currently unavailable.'
    }
    const render = (descriptors: readonly HostServiceConfigDescriptor[]): void => {
      if (!seat.isConnected) return
      seat.replaceChildren()
      if (descriptors.length === 0) {
        seat.append(dependencies.forms.empty(
          productLocale(dependencies.model.snapshot().localization.locale) === 'zh-CN'
            ? 'Provider 配置当前不可用。'
            : 'Provider configuration is currently unavailable.',
        ))
        return
      }
      for (const descriptor of descriptors) {
        const locale = dependencies.model.snapshot().localization.locale
        const runtime = descriptor.identity.serviceId === 'providers-runtime'
        const title = productLocale(locale) === 'zh-CN'
          ? (runtime ? 'Provider 连接' : '下次启动')
          : (runtime ? 'Provider connections' : 'Next launch')
        const description = productLocale(locale) === 'zh-CN'
          ? (runtime
            ? '保存后重启 Provider 服务；当前连接不会被伪造成原生连接。'
            : '保存为下次应用启动候选值；重启应用后生效。')
          : (runtime
            ? 'Saving restarts the Provider service; it never impersonates the native connection.'
            : 'Saved as the next app-start candidate and takes effect after restart.')
        const section = dependencies.forms.section(title, description)
        section.root.dataset.serviceConfig = descriptor.identity.serviceId
        section.root.dataset.configApplies = descriptor.configApplies
        const form = dependencies.forms.form(`${plugin.id}-${descriptor.identity.serviceId}`)
        form.dataset.serviceConfigForm = descriptor.identity.serviceId
        const configuration = descriptor.configuration as unknown as Record<string, CordisXJsonValue>
        const field: CordisXConfigFieldSnapshot = {
          namespace: plugin.id,
          path: ['providers'],
          type: 'array',
          label: productLocale(locale) === 'zh-CN' ? 'Provider 列表' : 'Provider list',
          description: productLocale(locale) === 'zh-CN'
            ? '使用已声明的 providerId、端点和模型映射；凭据引用由 Host 安全保管。'
            : 'Use declared providerId, endpoint, and model mappings; credential references stay Host-managed.',
          value: Array.isArray(configuration.providers) ? configuration.providers : [],
          disabled: !descriptor.writable,
          required: true,
        }
        const item = dependencies.forms.item({
          id: `cxm-service-${descriptor.identity.serviceId}-providers`,
          label: field.label!,
          ...(field.description === undefined ? {} : { help: field.description }),
          required: true,
          fullWidth: true,
        })
        item.root.dataset.serviceConfigPath = `${descriptor.identity.serviceId}.providers`
        const candidate = (typeof globalThis.structuredClone === 'function'
          ? globalThis.structuredClone(descriptor.configuration)
          : JSON.parse(JSON.stringify(descriptor.configuration))) as Record<string, CordisXJsonValue>
        let dirty = false
        const control = dependencies.forms.control(field, item.label.htmlFor, (value, issue) => {
          item.setError(issue)
          if (issue === undefined && Array.isArray(value)) {
            candidate.providers = value as unknown as CordisXJsonValue
            dirty = true
            setTDesignDisabled(save, false)
          } else {
            setTDesignDisabled(save, true)
          }
        })
        dependencies.forms.connect(item, control)
        item.control.append(control.root)
        section.content.append(item.root)
        const footer = create(dependencies.document, 'div', 'cxf-actions cxm-service-config-footer')
        const status = create(dependencies.document, 'span', 'cxf-status')
        status.setAttribute('role', 'status')
        if (descriptor.restartRequired) {
          status.dataset.state = 'dirty'
          status.textContent = productLocale(locale) === 'zh-CN'
            ? '已有候选配置，重启应用后生效。'
            : 'A candidate is waiting for app restart.'
        }
        const save = dependencies.forms.button(
          productLocale(locale) === 'zh-CN' ? '保存 Provider 配置' : 'Save Provider configuration',
          { type: 'submit', variant: 'primary' },
        )
        setTDesignDisabled(save, true)
        footer.append(status, save)
        form.append(section.root, footer)
        form.addEventListener('submit', event => {
          event.preventDefault()
          if (!dirty || item.root.dataset.invalid === 'true' || dependencies.model.updateServiceConfig === undefined) {
            return
          }
          setTDesignDisabled(save, true)
          form.setAttribute('aria-busy', 'true')
          status.dataset.state = 'saving'
          status.textContent = hostConfigApplyMessage(descriptor.configApplies, 'saving', locale)
          const mutation: HostServiceConfigMutation = {
            contract: 'cordisx.service-config-mutation/v1',
            schemaVersion: 1,
            identity: descriptor.identity,
            scope: descriptor.scope,
            expectedRevision: descriptor.revision,
            configuration: candidate as unknown as HostServiceConfigMutation['configuration'],
          }
          void dependencies.model.updateServiceConfig(mutation).then(async result => {
            if (result.status === 'rejected' || result.status === 'conflict') {
              const text = result.error.code === 'permission-denied'
                ? (productLocale(locale) === 'zh-CN'
                  ? '没有权限修改 Provider 配置。'
                  : 'You do not have permission to modify Provider configuration.')
                : result.error.code === 'conflict'
                ? (productLocale(locale) === 'zh-CN'
                  ? '配置已更新，请重新检查后再保存。'
                  : 'Configuration changed; review it before saving again.')
                : (productLocale(locale) === 'zh-CN'
                  ? 'Provider 配置未保存。'
                  : 'Provider configuration was not saved.')
              status.dataset.state = 'error'
              status.textContent = text
              return
            }
            status.dataset.state = 'saved'
            status.textContent = result.status === 'staged'
              ? (productLocale(locale) === 'zh-CN'
                ? '已保存，重启应用后生效。'
                : 'Saved; it takes effect after app restart.')
              : (productLocale(locale) === 'zh-CN'
                ? '已保存，Provider 服务已重启。'
                : 'Saved; the Provider service restarted.')
            dirty = false
            const fresh = await dependencies.model.listServiceConfigs?.(plugin.id)
            if (fresh !== undefined) render(fresh)
          }).catch(error => {
            status.dataset.state = 'error'
            status.textContent = unavailable(error)
          }).finally(() => {
            form.removeAttribute('aria-busy')
          })
        })
        seat.append(form)
        if (descriptor.secrets.length > 0) {
          seat.append(dependencies.forms.note(
            productLocale(locale) === 'zh-CN'
              ? '凭据仅以安全引用保存；此处不会显示或读取凭据值。'
              : 'Credentials are stored only as secure references; values are never displayed or read here.',
          ))
        }
      }
    }
    void dependencies.model.listServiceConfigs(plugin.id).then(render).catch(error => {
      if (!seat.isConnected) return
      seat.replaceChildren(dependencies.forms.alert(unavailable(error), 'warning'))
    })
  }

  const renderPluginConfiguration = (plugin: ManagerPluginSnapshot, panel: HTMLElement): void => {
    const locale = dependencies.model.snapshot().localization.locale
    const descriptor = plugin.configuration
    if (descriptor === undefined || descriptor.schemaKind !== 'schemastery') {
      panel.append(dependencies.forms.empty(managerCopy(locale, 'form.empty-no-schema')))
      renderPluginServiceConfiguration(plugin, panel)
      return
    }
    const sensitiveRoles = ['secret', 'credential', 'credential-ref', 'permission', 'capability']
    // A schema can deliberately expose a stable, read-only reference alongside
    // editable settings. Keep that product-facing value in the Host form so it
    // retains its label, help, a11y relationship, and disabled TDesign chrome;
    // only actions and custom renderer mounting remain edit-only below.
    const visibleFields = descriptor.fields
    const editableFields = descriptor.writable
      ? visibleFields.filter(field =>
        !field.disabled
        && !sensitiveRoles.includes(field.role ?? '') && selectHostFormPrimitive(field) !== 'unsupported'
      )
      : []
    if (visibleFields.length === 0) {
      panel.append(dependencies.forms.empty(managerCopy(locale, 'form.empty-no-fields')))
      renderPluginServiceConfiguration(plugin, panel)
      return
    }

    let draft = dependencies.configDrafts.get(plugin.id)
    if (draft === undefined) {
      draft = {
        baseRevision: descriptor.revision,
        values: new Map(),
        operations: new Map(),
        issues: new Map(),
        state: 'pristine',
      }
      dependencies.configDrafts.set(plugin.id, draft)
    } else if (draft.baseRevision !== descriptor.revision && draft.operations.size === 0) {
      draft.baseRevision = descriptor.revision
      if (draft.state !== 'saved') draft.state = 'pristine'
      delete draft.message
    }

    const form = dependencies.forms.form(plugin.id)
    form.dataset.pluginConfigForm = plugin.id
    form.dataset.state = draft.state
    const groupKeys = new Set(visibleFields.map(field => field.group?.id ?? '__root__'))
    const needsGeneralHeading = groupKeys.size > 1
    let generalGrid: HTMLElement | undefined
    const groupGrids = new Map<string, HTMLElement>()
    const gridFor = (field: CordisXConfigFieldSnapshot): HTMLElement => {
      if (field.group !== undefined) {
        const existing = groupGrids.get(field.group.id)
        if (existing !== undefined) return existing
        const title = field.group.title
        if (title !== undefined || needsGeneralHeading) {
          const section = dependencies.forms.section(
            title ?? managerCopy(locale, 'form.section-general'),
            field.group.description,
            field.group.icon,
          )
          groupGrids.set(field.group.id, section.content)
          form.append(section.root)
          return section.content
        }
        const grid = dependencies.forms.grid()
        groupGrids.set(field.group.id, grid)
        form.append(grid)
        return grid
      }
      if (generalGrid !== undefined) return generalGrid
      if (needsGeneralHeading) {
        const section = dependencies.forms.section(managerCopy(locale, 'form.section-general'))
        generalGrid = section.content
        form.append(section.root)
      } else {
        generalGrid = dependencies.forms.grid()
        form.append(generalGrid)
      }
      return generalGrid
    }
    let submit: TDesignButtonElement | undefined
    let actions: HTMLElement | undefined
    for (const [index, field] of visibleFields.entries()) {
      const grid = gridFor(field)
      const pathKey = JSON.stringify(field.path)
      const controlId = `cxm-config-${plugin.id}-${index}`
      const sensitive = field.role !== undefined && sensitiveRoles.includes(field.role)
      const primitive = selectHostFormPrimitive(field)
      const item = dependencies.forms.item({
        id: controlId,
        label: fieldLabel(field),
        ...(field.description === undefined ? {} : { help: field.description }),
        required: field.required,
        ...(field.icon === undefined ? {} : { icon: field.icon }),
        fullWidth: sensitive
          || ['textarea', 'json-textarea', 'path-input', 'tag-input', 'multi-select', 'object-array', 'unsupported']
            .includes(primitive),
      })
      item.root.dataset.configPath = field.path.join('.')
      item.root.dataset.hostFormPrimitive = primitive

      if (sensitive) {
        const control = dependencies.forms.control(field, controlId, () => undefined)
        dependencies.forms.connect(item, control)
        item.control.append(control.root)
        grid.append(item.root)
        continue
      }

      const setDraft = (value: unknown, issue?: string): void => {
        draft!.values.set(pathKey, value)
        draft!.operations.set(
          pathKey,
          value === undefined
            ? { op: 'unset', path: field.path }
            : { op: 'set', path: field.path, value: value as CordisXJsonValue },
        )
        const locale = dependencies.model.snapshot().localization.locale
        const validationIssue = issue ?? validateHostFormValue(field, value, locale)
        if (validationIssue === undefined) draft!.issues.delete(pathKey)
        else draft!.issues.set(pathKey, validationIssue)
        item.setError(validationIssue)
        draft!.state = 'dirty'
        delete draft!.message
        form.dataset.state = 'dirty'
        const status = actions?.querySelector<HTMLElement>('.cxf-status')
          ?? form.querySelector<HTMLElement>('.cxf-status')
        if (status !== null) {
          status.dataset.state = 'dirty'
          status.textContent = hostConfigApplyMessage(descriptor.applies, 'dirty', locale)
        }
        if (actions !== undefined && !actions.isConnected) form.insertBefore(actions, form.firstChild)
        if (submit !== undefined) {
          setTDesignDisabled(
            submit,
            !descriptor.writable || dependencies.busyPluginId !== undefined
              || draft!.operations.size === 0 || draft!.issues.size > 0,
          )
        }
      }
      const renderedField = {
        ...field,
        ...(draft.values.has(pathKey) ? { value: draft.values.get(pathKey) } : {}),
        disabled: field.disabled || !descriptor.writable,
      }
      const defaultHolder = create(dependencies.document, 'div')
      const control = dependencies.forms.control(renderedField, controlId, setDraft)
      dependencies.forms.connect(item, control)
      defaultHolder.append(control.root)
      item.control.append(defaultHolder)
      item.setError(draft.issues.get(pathKey))
      if (dependencies.model.mountConfigRenderer !== undefined && !field.disabled && descriptor.writable) {
        const custom = create(dependencies.document, 'div', 'cxm-config-renderer cxf-custom-seat')
        custom.hidden = true
        item.control.append(custom)
        void dependencies.model.mountConfigRenderer(plugin.id, renderedField, custom, setDraft).then(mount => {
          if (!item.root.isConnected) {
            void mount.dispose()
            return
          }
          dependencies.configRendererMounts.add(mount)
          if (mount.mounted) {
            custom.hidden = false
            const focusable = custom.querySelector<HTMLElement>('input,select,textarea,button,[tabindex]')
            if (focusable !== null) {
              if (focusable.id === '') focusable.id = controlId
              focusable.dataset.hostFormPrimitive = 'custom'
              focusable.setAttribute('aria-describedby', [item.help?.id, item.error.id].filter(Boolean).join(' '))
              if (field.required) focusable.setAttribute('aria-required', 'true')
            }
            defaultHolder.remove()
          }
        }).catch(() => undefined)
      }
      if (descriptor.writable) {
        const fieldMenu = dependencies.forms.fieldActionMenu({
          label: fieldLabel(field),
          ...(field.icon === undefined ? {} : { icon: field.icon }),
          canUseDefault: () => field.hasDefault === true,
          hasFieldDraft: () => draft!.operations.has(pathKey),
          useDefault: () => {
            if (field.hasDefault !== true) return
            const defaultValue = field.defaultValue
            draft!.values.set(pathKey, defaultValue)
            draft!.operations.set(pathKey, { op: 'unset', path: field.path })
            const issue = validateHostFormValue(field, defaultValue, dependencies.model.snapshot().localization.locale)
            if (issue === undefined) draft!.issues.delete(pathKey)
            else draft!.issues.set(pathKey, issue)
            draft!.state = 'dirty'
            delete draft!.message
            dependencies.renderContent()
          },
          rollback: () => {
            draft!.values.delete(pathKey)
            draft!.operations.delete(pathKey)
            draft!.issues.delete(pathKey)
            draft!.state = draft!.operations.size === 0 ? 'pristine' : 'dirty'
            delete draft!.message
            dependencies.renderContent()
          },
          copyPath: async () => {
            const clipboard = dependencies.document.defaultView?.navigator.clipboard
            if (typeof clipboard?.writeText !== 'function') return false
            try {
              await clipboard.writeText(field.path.join('.'))
              return true
            } catch {
              return false
            }
          },
        })
        item.labelRow.prepend(fieldMenu.trigger)
        dependencies.configFieldActionMenus.add(fieldMenu)
      }
      grid.append(item.root)
    }
    if (editableFields.length > 0) {
      actions = create(dependencies.document, 'div', 'cxf-actions cxf-form-footer')
      const status = create(dependencies.document, 'span', 'cxf-status')
      status.dataset.state = draft.state
      status.setAttribute('role', 'status')
      status.textContent = draft.state === 'saving'
        ? hostConfigApplyMessage(descriptor.applies, 'saving', locale)
        : draft.state === 'saved'
        ? hostConfigApplyMessage(descriptor.applies, 'saved', locale)
        : draft.operations.size > 0
        ? hostConfigApplyMessage(descriptor.applies, 'dirty', locale)
        : ''
      const resetDraft = dependencies.forms.button(managerCopy(locale, 'form.undo-changes'), {
        action: 'undo',
        density: 'icon',
        ...(descriptor.actionIcons?.reset === undefined ? {} : { icon: descriptor.actionIcons.reset }),
      })
      setTDesignDisabled(resetDraft, draft.operations.size === 0 || dependencies.busyPluginId !== undefined)
      resetDraft.addEventListener('click', () => {
        draft!.values.clear()
        draft!.operations.clear()
        draft!.issues.clear()
        draft!.state = 'pristine'
        delete draft!.message
        dependencies.renderContent()
      })
      submit = dependencies.forms.button(
        dependencies.busyPluginId === plugin.id
          ? managerCopy(locale, 'form.saving')
          : managerCopy(locale, 'form.save-configuration'),
        {
          type: 'submit',
          variant: 'primary',
          density: 'icon',
          action: 'save',
          ...(descriptor.actionIcons?.save === undefined ? {} : { icon: descriptor.actionIcons.save }),
        },
      )
      setTDesignDisabled(
        submit,
        !descriptor.writable || dependencies.busyPluginId !== undefined || draft.operations.size === 0
          || draft.issues.size > 0,
      )
      actions.append(status, resetDraft, submit)
      if (draft.operations.size > 0 || ['saving', 'saved', 'conflict', 'error'].includes(draft.state)) {
        form.insertBefore(actions, form.firstChild)
      }
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        if (
          dependencies.model.updatePluginConfig === undefined || draft!.operations.size === 0 || draft!.issues.size > 0
        ) return
        dependencies.busyPluginId = plugin.id
        draft!.state = 'saving'
        delete draft!.message
        setTDesignDisabled(submit!, true)
        submit!.setAttribute(
          'aria-label',
          managerCopy(dependencies.model.snapshot().localization.locale, 'form.saving'),
        )
        submit!.setAttribute('title', managerCopy(dependencies.model.snapshot().localization.locale, 'form.saving'))
        status.dataset.state = 'saving'
        status.textContent = hostConfigApplyMessage(
          descriptor.applies,
          'saving',
          dependencies.model.snapshot().localization.locale,
        )
        form.setAttribute('aria-busy', 'true')
        try {
          await dependencies.model.updatePluginConfig(plugin.id, draft!.baseRevision, [...draft!.operations.values()])
          draft!.values.clear()
          draft!.operations.clear()
          draft!.issues.clear()
          draft!.state = 'saved'
          draft!.message = managerCopy(locale, 'form.configuration-saved')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          draft!.state = /conflict|revision/iu.test(message) ? 'conflict' : 'error'
          draft!.message = draft!.state === 'conflict'
            ? managerCopy(locale, 'form.conflict-retained')
            : managerCopy(dependencies.model.snapshot().localization.locale, 'form.configuration-save-failed')
        } finally {
          dependencies.busyPluginId = undefined
          dependencies.renderContent()
        }
      })
    }
    panel.append(form)
    if (!descriptor.writable) panel.append(dependencies.forms.note(managerCopy(locale, 'form.readonly-note')))
    if (draft.message !== undefined) {
      panel.append(dependencies.forms.alert(draft.message, draft.state === 'saved' ? 'info' : 'error'))
    }
    renderPluginServiceConfiguration(plugin, panel)
  }
  return { renderPluginConfiguration }
}
