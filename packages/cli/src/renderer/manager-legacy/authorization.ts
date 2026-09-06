import type { CordisXCapabilityAvailabilityState } from '../../capability-availability-contracts.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  type CordisXCapabilityScope,
  type CordisXLocalizedText,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionAuthorizationPlanV1,
  type CordisXPermissionPolicy,
  type CordisXPlatformCapability,
} from '../../contracts.js'
import { PermissionAuthorizationViewModel } from '../../permission-authorization-view-model.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionCapabilityV2,
  CordisXPermissionCapabilityV4,
} from '../../permission-contracts.js'
import { HOST_FORM_STYLES, HostFormAdapter } from '.././host-form.js'
import { HostThemeProjection } from '.././host-theme.js'
import { createManagerIcon } from '.././icons.js'
import { BrowserPermissionAuthorizationDialog } from '.././permission-authorization-dialog.js'
import {
  createTDesignElement,
  setTDesignProps,
  type TDesignElement,
  type TDesignSelectElement,
} from '.././tdesign-form.js'
import { managerCopy } from '.././ui-copy.js'
import { create } from './dom.js'
import { ManagerPermissionSnapshot, ManagerPluginSnapshot } from './model.js'
import { CAPABILITY_PRESENTATIONS, CapabilityPresentation, POLICY_LABELS } from './presentation.js'

export function capabilityPresentation(capability: CordisXPermissionCapabilityV4): CapabilityPresentation {
  const known =
    (CAPABILITY_PRESENTATIONS as Readonly<Partial<Record<CordisXPermissionCapabilityV4, CapabilityPresentation>>>)[
      capability
    ]
  if (known !== undefined) return known
  const group = String(capability).split('.')[0]
  return {
    name: group === 'models'
      ? '使用模型能力'
      : group === 'tasks'
      ? '使用任务能力'
      : group === 'turns'
      ? '使用对话能力'
      : '使用宿主能力',
    icon: 'capability-fallback',
  }
}

export function createCapabilityIcon(document: Document, capability: CordisXPermissionCapabilityV4): HTMLSpanElement {
  return createManagerIcon(document, capabilityPresentation(capability).icon, 'cxm-capability-icon')
}

export function capabilityAvailabilityLabel(status: CordisXCapabilityAvailabilityState, locale = 'zh-CN'): string {
  return status === 'supported'
    ? managerCopy(locale, 'runtime.availability-supported')
    : status === 'degraded'
    ? managerCopy(locale, 'runtime.availability-degraded')
    : managerCopy(locale, 'runtime.unavailable')
}

export function createPermissionPolicySelect(
  forms: HostFormAdapter,
  permission: ManagerPermissionSnapshot,
  onChange: (policy: CordisXPermissionPolicy, control: TDesignSelectElement<CordisXPermissionPolicy>) => Promise<void>,
): TDesignSelectElement<CordisXPermissionPolicy> {
  let policy: TDesignSelectElement<CordisXPermissionPolicy>
  policy = forms.select(
    `${capabilityPresentation(permission.capability).name}的权限策略`,
    (['ask', 'allow', 'deny'] as const).map(value => ({ value, label: POLICY_LABELS[value] })),
    permission.policy,
    value => {
      if (value !== undefined) void onChange(value, policy)
    },
  )
  policy.classList.add('cxm-permission-policy-select')
  policy.dataset.hostFormPrimitive = 'select'
  policy.dataset.permissionCapability = permission.capability
  return policy
}

export async function requestPluginAuthorization(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV1,
  permissions: readonly ManagerPermissionSnapshot[],
  localeProvider: () => string = () => document.documentElement.lang || 'zh-CN',
): Promise<CordisXPermissionAuthorizationDecisionV1 | undefined> {
  const decisionEnvelope = (
    decision: CordisXPermissionAuthorizationDecisionV1['decisions'][number]['decision'],
    selected: (capability: CordisXPlatformCapability) => boolean,
  ): CordisXPermissionAuthorizationDecisionV1 => ({
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
    schemaVersion: 1,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    decisions: plan.declarations.map(declaration => ({
      capability: declaration.capability,
      scope: declaration.scope,
      decision: decision === 'deny' || !selected(declaration.capability) ? 'deny' : decision,
    })),
  })
  if (plan.declarations.length === 0) return decisionEnvelope('allow', () => true)
  return await new Promise((resolve) => {
    const overlay = create(document, 'div', 'cxm-authorization-overlay cxf-scope')
    const forms = new HostFormAdapter(document, overlay, localeProvider)
    const theme = new HostThemeProjection(document)
    const detachTheme = theme.attach(overlay)
    overlay.dataset.permissionAuthorization = plugin.id
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    const titleId = `cxm-authorization-${plugin.id}`
    overlay.setAttribute('aria-labelledby', titleId)
    const style = document.createElement('style')
    style.textContent = `${HOST_FORM_STYLES}
      .cxm-authorization-overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; background: var(--cx-backdrop); }
      .cxm-authorization-dialog { width: min(600px, 100%); max-height: min(720px, calc(100vh - 48px)); overflow: auto; border: 1px solid var(--cx-border); border-radius: 14px; padding: 20px; background: var(--cx-surface); color: var(--cx-text); box-shadow: 0 24px 80px var(--cx-shadow); }
      .cxm-authorization-dialog h2 { margin: 0; font-size: 18px; }
      .cxm-authorization-dialog > p { margin: 9px 0 16px; color: var(--cx-muted); line-height: 1.5; }
      .cxm-authorization-list { display: grid; }
      .cxm-authorization-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 14px; padding: 12px 0; border-top: 1px solid var(--cx-border); }
      .cxm-authorization-item:first-child { border-top: 0; }
      .cxm-authorization-name { font-weight: 600; }
      .cxm-authorization-reason { color: var(--cx-muted); line-height: 1.45; }
      .cxm-authorization-choice { grid-column: 2; grid-row: 1 / span 2; align-self: center; display: flex; align-items: center; gap: 9px; color: var(--cx-text); cursor: pointer; }
      .cxm-authorization-choice t-checkbox { flex: 0 0 auto; }
      .cxm-authorization-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 18px; }
      .cxm-authorization-actions button { border: 1px solid var(--cx-border); border-radius: 9px; padding: 8px 12px; background: var(--cx-surface-raised); color: var(--cx-text); cursor: pointer; }
      .cxm-authorization-actions button[data-primary="true"] { border-color: var(--cx-primary); background: var(--cx-primary); color: var(--cx-primary-text); font-weight: 600; }
      .cxm-authorization-actions button[data-tone="danger"] { color: var(--cx-danger); }
      .cxm-authorization-actions button:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 2px; }
    `
    const dialog = create(document, 'div', 'cxm-authorization-dialog')
    const operationLabel = plan.operation === 'install' ? '安装' : plan.operation === 'update' ? '更新' : '启用'
    const title = create(document, 'h2', undefined, `${operationLabel}授权`)
    title.id = titleId
    dialog.append(title, create(document, 'p', undefined, `${plugin.name} 声明了以下宿主能力。持久授权是默认主操作。`))
    const list = create(document, 'div', 'cxm-authorization-list')
    list.setAttribute('role', 'list')
    const choices = new Map<CordisXPlatformCapability, TDesignElement>()
    for (const declaration of plan.declarations) {
      const projected = permissions.find(item => item.capability === declaration.capability)
      const presentation = capabilityPresentation(declaration.capability)
      const item = create(document, 'div', 'cxm-authorization-item')
      item.setAttribute('role', 'listitem')
      item.dataset.authorizationCapability = declaration.capability
      const choice = createTDesignElement(document, 't-checkbox', 'checkbox')
      choice.checked = true
      choice.disabled = declaration.required
      choice.dataset.authorizationChoice = declaration.capability
      choice.setAttribute('aria-label', `${presentation.name}（${declaration.required ? '必需' : '可选'}）`)
      choice.setAttribute('aria-checked', 'true')
      setTDesignProps(choice, {
        checked: true,
        disabled: declaration.required,
        onChange: (checked: boolean) => {
          choice.checked = checked
          choice.setAttribute('aria-checked', String(checked))
        },
      })
      if (document.defaultView?.customElements.get('t-checkbox') === undefined) {
        choice.addEventListener('click', () => {
          if (choice.disabled) return
          choice.checked = choice.checked !== true
          choice.setAttribute('aria-checked', String(choice.checked))
        })
      }
      choices.set(declaration.capability, choice)
      const choiceLabel = create(document, 'div', 'cxm-authorization-choice cxf-choice')
      choiceLabel.append(choice, create(document, 'span', undefined, `当前：${POLICY_LABELS[declaration.policy]}`))
      item.append(
        create(
          document,
          'div',
          'cxm-authorization-name',
          `${presentation.name} · ${declaration.required ? '必需' : '可选'}`,
        ),
        create(
          document,
          'div',
          'cxm-authorization-reason',
          projected?.reasonText ?? declaration.reason.fallback ?? declaration.reason.key,
        ),
        choiceLabel,
      )
      list.append(item)
    }
    dialog.append(list)
    const actions = create(document, 'div', 'cxm-authorization-actions')
    const finish = (
      decision: CordisXPermissionAuthorizationDecisionV1['decisions'][number]['decision'] | undefined,
    ): void => {
      detachTheme()
      overlay.remove()
      resolve(
        decision === undefined ? undefined : decisionEnvelope(
          decision,
          capability => choices.get(capability)?.checked === true,
        ),
      )
    }
    const cancel = forms.button('取消')
    cancel.dataset.authorizationDecision = 'cancel'
    cancel.addEventListener('click', () => finish(undefined), { once: true })
    const deny = forms.button(`拒绝并保持${operationLabel === '安装' ? '未安装' : '停用'}`, { tone: 'danger' })
    deny.dataset.authorizationDecision = 'deny'
    deny.dataset.tone = 'danger'
    deny.addEventListener('click', () => finish('deny'), { once: true })
    const once = forms.button(`仅此次允许并${operationLabel}`)
    once.dataset.authorizationDecision = 'allow-once'
    once.addEventListener('click', () => finish('allow-once'), { once: true })
    const allow = forms.button(`始终允许并${operationLabel}`, { variant: 'primary' })
    allow.dataset.authorizationDecision = 'allow'
    allow.dataset.primary = 'true'
    allow.addEventListener('click', () => finish('allow'), { once: true })
    overlay.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      finish(undefined)
    })
    actions.append(cancel, deny, once, allow)
    dialog.append(actions)
    overlay.append(style, dialog)
    document.body.append(overlay)
    allow.focus()
  })
}

export async function requestPluginAuthorizationV2(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV2,
  permissions: readonly ManagerPermissionSnapshot[],
): Promise<CordisXPermissionAuthorizationDecisionV2 | undefined> {
  if (plan.declarations.length === 0) {
    const result = new PermissionAuthorizationViewModel(plan).confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 2 ? result.decision : undefined
  }
  const availability = Object.fromEntries(plan.declarations.flatMap(declaration => {
    const permission = permissions.find(item => item.capability === declaration.capability)
    if (permission === undefined) return []
    return [[
      declaration.capability,
      Object.freeze({
        status: permission.availability.status,
        reason: Object.freeze({
          namespace: 'cordisx.permission.host',
          key: `availability.${declaration.capability}`,
          fallback: permission.availability.reasonText,
        }),
        providerIds: Object.freeze(permission.availability.providers.map(provider => provider.providerId)),
      }),
    ]]
  })) as Partial<
    Record<CordisXPermissionCapabilityV2, {
      readonly status: 'supported' | 'degraded' | 'unavailable'
      readonly reason: CordisXLocalizedText
      readonly providerIds: readonly string[]
    }>
  >
  const dialog = new BrowserPermissionAuthorizationDialog(document)
  try {
    const result = await dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => ({
        plugin: { name: plugin.name, source: plugin.source, trust: 'configured' },
        availability,
        resolve: message => message.fallback ?? `[[${message.namespace ?? 'permission'}:${message.key}]]`,
        scope: scope => Object.keys(scope).length === 0 ? 'Host default scope' : JSON.stringify(scope),
        requestSource: plugin.source,
      }),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 2 ? result.decision : undefined
  } finally {
    dialog.dispose()
  }
}

export async function requestPluginAuthorizationV4(
  document: Document,
  plugin: Pick<ManagerPluginSnapshot, 'id' | 'source' | 'name'>,
  plan: CordisXPermissionAuthorizationPlanV4,
  permissions: readonly ManagerPermissionSnapshot[],
): Promise<CordisXPermissionAuthorizationDecisionV4 | undefined> {
  if (!plan.declarations.some(item => item.decisionRequired)) {
    const result = new PermissionAuthorizationViewModel(plan).confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 4 ? result.decision : undefined
  }
  const availability = Object.fromEntries(plan.declarations.flatMap(declaration => {
    const permission = permissions.find(item => item.capability === declaration.capability)
    if (permission === undefined) return []
    return [[
      declaration.capability,
      Object.freeze({
        status: permission.availability.status,
        reason: Object.freeze({
          namespace: 'cordisx.permission.host',
          key: `availability.${declaration.capability}`,
          fallback: permission.availability.reasonText,
        }),
        providerIds: Object.freeze(permission.availability.providers.map(provider => provider.providerId)),
      }),
    ]]
  }))
  const dialog = new BrowserPermissionAuthorizationDialog(document)
  try {
    const result = await dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => ({
        plugin: { name: plugin.name, source: plugin.source, trust: 'configured' },
        availability,
        resolve: message => message.fallback ?? `[[${message.namespace ?? 'permission'}:${message.key}]]`,
        scope: scope => Object.keys(scope).length === 0 ? 'Host default scope' : JSON.stringify(scope),
        requestSource: plugin.source,
      }),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 4 ? result.decision : undefined
  } finally {
    dialog.dispose()
  }
}

export function hasCapabilityScope(scope: CordisXCapabilityScope): boolean {
  return Object.values(scope).some(value => Array.isArray(value) && value.length > 0)
}
