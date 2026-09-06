import { type CordisXIconToken, type CordisXPermissionPolicy } from '../../contracts.js'
import type { CordisXPermissionCapabilityV4 } from '../../permission-contracts.js'
import { HostFormAdapter } from '.././host-form.js'
import { type ManagerIconToken } from '.././icons.js'
import { type TDesignSelectElement } from '.././tdesign-form.js'
import {
  capabilityAvailabilityLabel,
  capabilityPresentation,
  createCapabilityIcon,
  createPermissionPolicySelect,
  hasCapabilityScope,
} from './authorization.js'
import { create } from './dom.js'
import { ManagerModel, ManagerPermissionSnapshot, ManagerSnapshot } from './model.js'
import { createSectionTitle, formatConfig } from './widgets.js'

export interface PermissionsDependencies {
  operationError: string | undefined
  model: ManagerModel
  renderContent: () => void
  setHeading: (
    headingCopy: string | undefined,
    snapshot: ManagerSnapshot,
    options?: { readonly icon?: ManagerIconToken | CordisXIconToken; readonly brand?: boolean },
  ) => void
  content: HTMLDivElement
  document: Document
  forms: HostFormAdapter
}

/** Dependencies are live views of installation-owned state; this module owns no duplicate lifecycle. */
export function createPermissions(dependencies: PermissionsDependencies) {
  const commitPermissionPolicy = async (
    pluginId: string,
    permission: ManagerPermissionSnapshot,
    policy: CordisXPermissionPolicy,
    control: TDesignSelectElement<CordisXPermissionPolicy>,
  ): Promise<void> => {
    dependencies.operationError = undefined
    control.setBusy(true)
    try {
      await dependencies.model.setPermissionPolicy(pluginId, permission.capability, policy, permission.scope)
    } catch (error) {
      dependencies.operationError = error instanceof Error ? error.message : String(error)
    } finally {
      dependencies.renderContent()
    }
  }

  const renderPermissionDetail = (
    snapshot: ManagerSnapshot,
    pluginId: string,
    capability: CordisXPermissionCapabilityV4,
    fingerprint: string,
  ): void => {
    const plugin = snapshot.plugins.find(item => item.id === pluginId)
    const permission = snapshot.permissions.find(item => (
      item.identity.id === pluginId
      && item.identity.source === plugin?.source
      && item.capability === capability
      && item.fingerprint === fingerprint
    ))
    const presentation = capabilityPresentation(capability)
    dependencies.setHeading(plugin === undefined ? '插件权限详情' : `${plugin.name} 申请的权限`, snapshot)
    if (plugin === undefined || permission === undefined) {
      dependencies.content.append(create(dependencies.document, 'div', 'cxm-empty', '该权限声明已不在当前 bundle 中'))
      return
    }

    const detail = create(dependencies.document, 'div', 'cxm-permission-detail')
    detail.dataset.permissionDetail = permission.capability
    const intro = create(dependencies.document, 'div', 'cxm-permission-detail-intro')
    const introCopy = create(dependencies.document, 'div')
    introCopy.append(create(dependencies.document, 'p', 'cxm-copy', permission.reasonText))
    intro.append(createCapabilityIcon(dependencies.document, permission.capability), introCopy)
    detail.append(intro)

    const info = dependencies.forms.section('权限信息')
    for (
      const [label, value] of [
        ['申请类型', permission.required ? '必需权限' : '可选权限'],
        ['可用状态', capabilityAvailabilityLabel(permission.availability.status)],
        ['能力标识', permission.capability],
      ]
    ) {
      const row = create(dependencies.document, 'div', 'cxm-settings-info-row')
      row.append(
        create(dependencies.document, 'div', 'cxm-settings-info-label', label),
        create(dependencies.document, 'div', 'cxm-settings-info-value', value),
      )
      info.content.append(row)
    }
    detail.append(info.root)

    if (permission.authorizationOrigin !== undefined) {
      const authorization = dependencies.forms.section(
        permission.authorizationOrigin === 'certified-implicit' ? '认证自动批准的 DOM 权限' : '最近授权来源',
        permission.authorizationReason ?? (permission.authorizationOrigin === 'certified-implicit'
          ? 'Host 根据精确制品认证投影自动批准；权限仍由 PermissionBroker 签发并审计。'
          : '由用户显式确认。'),
      )
      authorization.root.dataset.permissionAuthorizationOrigin = permission.authorizationOrigin
      if (permission.certification !== undefined) {
        for (
          const [label, value] of [
            ['制品', `${permission.certification.pluginId}@${permission.certification.version}`],
            ['完整性', permission.certification.integrity],
            [
              '审核策略',
              `${permission.certification.reviewPolicy.id}@${permission.certification.reviewPolicy.version}`,
            ],
            ['证据', permission.certification.evidence.reference],
            ['投影 revision', permission.certification.revision],
            ['投影 fingerprint', permission.certification.fingerprint],
          ]
        ) {
          const row = create(dependencies.document, 'div', 'cxm-settings-info-row')
          row.append(
            create(dependencies.document, 'div', 'cxm-settings-info-label', label),
            create(dependencies.document, 'div', 'cxm-settings-info-value', value),
          )
          authorization.content.append(row)
        }
      }
      detail.append(authorization.root)
    }

    const policySection = dependencies.forms.section(
      '访问策略',
      '选择每次询问、始终允许或始终拒绝；策略由 Host 保存并执行。',
    )
    const policyItem = dependencies.forms.item({
      id: `cxm-permission-policy-${permission.capability.replaceAll('.', '-')}`,
      label: '权限策略',
      help: permission.required ? '拒绝必需权限会停止插件运行。' : '可随时返回此页修改。',
    })
    const policySelect = createPermissionPolicySelect(dependencies.forms, permission, async (policy, control) => {
      await commitPermissionPolicy(plugin.id, permission, policy, control)
    })
    policySelect.classList.add('cxm-permission-detail-policy')
    policySelect.id = policyItem.label.htmlFor
    policySelect.setAttribute('aria-labelledby', policyItem.label.id)
    policyItem.control.append(policySelect)
    policySection.content.append(policyItem.root)
    detail.append(policySection.root)
    if (permission.required && permission.policy === 'deny') {
      const blocked = create(
        dependencies.document,
        'div',
        'cxm-notice',
        '这是一项必需权限。保持“始终拒绝”时，插件将停止运行。',
      )
      blocked.dataset.tone = 'warning'
      detail.append(blocked)
    }

    if (hasCapabilityScope(permission.scope)) {
      detail.append(createSectionTitle(dependencies.document, '使用范围'))
      detail.append(create(dependencies.document, 'pre', 'cxm-code', formatConfig(permission.scope)))
    }

    detail.append(createSectionTitle(dependencies.document, '能力提供方'))
    if (permission.availability.providers.length === 0) {
      detail.append(create(dependencies.document, 'div', 'cxm-empty', permission.availability.reasonText))
    } else {
      const providers = create(dependencies.document, 'div', 'cxm-flat-list')
      providers.setAttribute('role', 'list')
      providers.dataset.permissionProviders = permission.capability
      for (const provider of permission.availability.providers) {
        const providerItem = create(dependencies.document, 'div', 'cxm-flat-item cxm-permission-provider-item')
        providerItem.setAttribute('role', 'listitem')
        providerItem.dataset.permissionProvider = provider.providerId
        const copy = create(dependencies.document, 'div', 'cxm-permission-copy')
        copy.append(
          create(dependencies.document, 'span', 'cxm-permission-name', provider.providerNameText),
          create(dependencies.document, 'span', 'cxm-permission-reason', provider.reasonText),
        )
        providerItem.append(
          copy,
          create(dependencies.document, 'span', 'cxm-kind-badge', capabilityAvailabilityLabel(provider.status)),
        )
        if (provider.scope !== undefined && hasCapabilityScope(provider.scope)) {
          const scope = create(dependencies.document, 'pre', 'cxm-code', formatConfig(provider.scope))
          scope.dataset.permissionProviderScope = provider.providerId
          providerItem.append(scope)
        }
        providers.append(providerItem)
      }
      detail.append(providers)
    }

    detail.append(createSectionTitle(dependencies.document, '本次运行审计'))
    const target = permission.lastRequested === undefined ? '无' : JSON.stringify(permission.lastRequested)
    const audit =
      permission.lastUsedAt === undefined && permission.lastDeniedAt === undefined && permission.denialCount === 0
        ? '本次运行尚无调用记录'
        : `最近目标：${target} · 最近允许：${permission.lastUsedAt ?? '无'} · 最近拒绝：${
          permission.lastDeniedAt ?? '无'
        } · 拒绝次数：${permission.denialCount}`
    detail.append(create(dependencies.document, 'p', 'cxm-copy cxm-permission-audit', audit))
    if (dependencies.operationError !== undefined) {
      detail.append(create(dependencies.document, 'div', 'cxm-error', dependencies.operationError))
    }
    dependencies.content.append(detail)
  }
  return { commitPermissionPolicy, renderPermissionDetail }
}
