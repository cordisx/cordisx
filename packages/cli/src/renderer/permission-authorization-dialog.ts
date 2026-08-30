import {
  type PermissionAuthorizationDialogProjection,
  type PermissionAuthorizationDialogResult,
  type PermissionAuthorizationItemProjection,
  type PermissionAuthorizationProjectionInput,
  PermissionAuthorizationViewModel,
} from '../permission-authorization-view-model.js'
import type {
  CordisXPermissionAuthorizationBindingV2,
  CordisXPermissionCapabilityV4,
  CordisXPermissionDecisionV2,
} from '../permission-contracts.js'
import { HOST_FORM_STYLES, HostFormAdapter } from './host-form.js'
import {
  createTDesignElement,
  setTDesignProps,
  setTDesignText,
  type TDesignButtonElement,
  type TDesignElement,
} from './tdesign-form.js'
import { createHostSurfaceIcon } from './icons.js'
import { HostThemeProjection } from './host-theme.js'

export interface PermissionAuthorizationDialogRequest {
  /** Returns a fresh locale projection without changing the underlying request. */
  readonly project: () => PermissionAuthorizationProjectionInput
  readonly subscribeLocale?: (listener: () => void) => () => void
}

interface MountedItem {
  readonly capability: CordisXPermissionCapabilityV4
  readonly name: HTMLElement
  readonly requirement: HTMLElement
  readonly sensitivity: HTMLElement
  readonly reviewMode: HTMLElement
  readonly descriptionLabel: HTMLElement
  readonly description: HTMLElement
  readonly risk: HTMLElement
  readonly limitationLabel: HTMLElement
  readonly limitation: HTMLElement
  readonly scopeLabel: HTMLElement
  readonly scope: HTMLElement
  readonly availability?: HTMLElement
  readonly rationale?: {
    readonly label: HTMLElement
    readonly title: HTMLElement
    readonly description: HTMLElement
    readonly featureLabel: HTMLElement
    readonly feature: HTMLElement
    readonly deniedBehaviorLabel: HTMLElement
    readonly deniedBehavior: HTMLElement
  }
  readonly authorizationLabel: HTMLElement
  readonly options: ReadonlyMap<CordisXPermissionDecisionV2, { readonly input: TDesignElement; readonly label: HTMLElement }>
  readonly denialImpact: HTMLElement
  readonly technicalSummary: HTMLElement
  readonly capabilityLabel: HTMLElement
  readonly capabilityValue: HTMLElement
  readonly providersLabel: HTMLElement
  readonly providersValue: HTMLElement
  readonly runtimeLabel: HTMLElement
  readonly runtimeValue: HTMLElement
  readonly moduleLabel: HTMLElement
  readonly moduleValue: HTMLElement
  readonly requestLabel: HTMLElement
  readonly requestValue: HTMLElement
}

interface ActiveDialog {
  readonly requestKey: string
  readonly finish: (result: PermissionAuthorizationDialogResult) => void
}

interface QueuedDialog {
  readonly requestKey: string
  readonly viewModel: PermissionAuthorizationViewModel
  readonly request: PermissionAuthorizationDialogRequest
  readonly resolve: (result: PermissionAuthorizationDialogResult) => void
  readonly reject: (reason?: unknown) => void
}

function dialogRequestKey(planId: string, binding: CordisXPermissionAuthorizationBindingV2): string {
  return [
    planId,
    binding.operationId,
    binding.runtimeGeneration,
    binding.moduleGeneration ?? '',
    binding.requestId ?? '',
  ].join('\u0000')
}

const STYLE = `${HOST_FORM_STYLES}
  .cxp-overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; box-sizing: border-box; background: var(--cx-backdrop); color: var(--cx-text); }
  .cxp-dialog { width: min(680px, 100%); max-height: min(760px, calc(100vh - 48px)); overflow: auto; box-sizing: border-box; border: 1px solid var(--cx-border); border-radius: 16px; padding: 20px; background: var(--cx-surface); color: var(--cx-text); box-shadow: 0 24px 80px var(--cx-shadow); }
  .cxp-header { display: flex; gap: 12px; align-items: flex-start; }
  .cxp-icon { display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 auto; border-radius: 10px; background: var(--cx-hover); color: var(--cx-primary); }
  .cxp-header-copy { min-width: 0; flex: 1; }
  .cxp-title { margin: 0; font-size: 19px; line-height: 1.3; }
  .cxp-plugin-name { margin: 5px 0 0; font-weight: 600; }
  .cxp-plugin-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 10px; margin: 8px 0 0; color: var(--cx-muted); font-size: 12px; }
  .cxp-plugin-meta dt, .cxp-plugin-meta dd { margin: 0; min-width: 0; }
  .cxp-plugin-meta dd { overflow-wrap: anywhere; color: var(--cx-text); }
  .cxp-list { display: grid; margin-top: 18px; }
  .cxp-item { padding: 18px 0; border-top: 1px solid var(--cx-border); }
  .cxp-item:first-child { border-top: 0; }
  .cxp-item-heading { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
  .cxp-item-heading h3 { margin: 0; font-size: 15px; }
  .cxp-badge { border: 1px solid var(--cx-border); border-radius: 999px; padding: 2px 7px; color: var(--cx-muted); font-size: 11px; }
  .cxp-badge[data-risk="high-risk"], .cxp-risk[data-risk="high-risk"] { color: var(--cx-danger); }
  .cxp-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 12px; margin: 12px 0 0; font-size: 13px; line-height: 1.45; }
  .cxp-facts dt, .cxp-facts dd { margin: 0; min-width: 0; }
  .cxp-facts dt { color: var(--cx-muted); }
  .cxp-facts dd { overflow-wrap: anywhere; }
  .cxp-risk { margin: 10px 0 0; color: var(--cx-muted); font-size: 13px; line-height: 1.45; }
  .cxp-availability { margin-top: 10px; color: var(--cx-muted); font-size: 12px; }
  .cxp-rationale { margin-top: 13px; padding: 12px 0 0 12px; border-left: 2px solid var(--cx-border); }
  .cxp-rationale-label { margin: 0 0 7px; color: var(--cx-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .cxp-rationale-title { margin: 0; font-size: 13px; font-weight: 600; }
  .cxp-rationale-description { margin: 4px 0 0; color: var(--cx-muted); font-size: 13px; line-height: 1.45; }
  .cxp-rationale dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; margin: 8px 0 0; font-size: 12px; }
  .cxp-rationale dt, .cxp-rationale dd { margin: 0; }
  .cxp-rationale dt { color: var(--cx-muted); }
  .cxp-decisions { min-width: 0; margin: 14px 0 0; padding: 0; border: 0; }
  .cxp-decisions legend { margin-bottom: 7px; padding: 0; font-size: 12px; font-weight: 600; }
  .cxp-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
  .cxp-option { display: flex; gap: 8px; align-items: center; min-width: 0; border: 1px solid var(--cx-border); border-radius: 10px; padding: 9px 10px; background: var(--cx-surface-raised); cursor: pointer; }
  .cxp-option:hover { background: var(--cx-hover); }
  .cxp-option:has(t-radio[aria-checked="true"]) { border-color: var(--cx-primary); }
  .cxp-option t-radio { flex: 0 0 auto; margin: 0; }
  .cxp-option span { overflow-wrap: anywhere; font-size: 13px; }
  .cxp-denial { margin: 8px 0 0; color: var(--cx-danger); font-size: 12px; line-height: 1.4; }
  .cxp-technical { margin-top: 12px; color: var(--cx-muted); font-size: 12px; }
  .cxp-technical summary { width: fit-content; cursor: pointer; color: var(--cx-text); }
  .cxp-technical dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; margin: 8px 0 0; }
  .cxp-technical dt, .cxp-technical dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .cxp-actions { display: flex; align-items: center; gap: 8px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--cx-border); }
  .cxp-actions .cxp-manage { margin-right: auto; }
  .cxp-button { border: 1px solid var(--cx-border); border-radius: 9px; padding: 8px 12px; background: var(--cx-surface-raised); color: var(--cx-text); font: inherit; cursor: pointer; }
  .cxp-button:hover { background: var(--cx-hover); }
  .cxp-button:active { background: var(--cx-pressed); }
  .cxp-button[data-primary="true"] { border-color: var(--cx-primary); background: var(--cx-primary); color: var(--cx-primary-text); font-weight: 600; }
  .cxp-button:disabled { opacity: var(--cx-disabled); cursor: not-allowed; }
  .cxp-button, .cxp-option, .cxp-option t-radio, .cxp-technical summary { -webkit-app-region: no-drag; }
  .cxp-button:focus-visible, .cxp-option t-radio:focus-visible, .cxp-technical summary:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 2px; }
  @media (max-width: 560px) { .cxp-overlay { padding: 10px; } .cxp-dialog { max-height: calc(100vh - 20px); } .cxp-options { grid-template-columns: 1fr; } .cxp-actions { flex-wrap: wrap; } }
`

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function noDrag(node: HTMLElement): void {
  node.style.setProperty('-webkit-app-region', 'no-drag')
}

function text(node: Node, value: string): void {
  if (node.textContent !== value) node.textContent = value
}

function focusable(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
    .filter(node => !node.hidden)
}

/** One queued Host-owned surface shared by install/enable and runtime reviews. */
export class BrowserPermissionAuthorizationDialog {
  private readonly theme: HostThemeProjection
  private readonly ownsTheme: boolean
  private readonly queue: QueuedDialog[] = []
  private active: ActiveDialog | undefined
  private disposed = false

  constructor(private readonly document: Document, theme?: HostThemeProjection) {
    this.theme = theme ?? new HostThemeProjection(document)
    this.ownsTheme = theme === undefined
  }

  show(
    viewModel: PermissionAuthorizationViewModel,
    request: PermissionAuthorizationDialogRequest,
  ): Promise<PermissionAuthorizationDialogResult> {
    if (this.disposed) return Promise.resolve(Object.freeze({ status: 'cancelled' }))
    return new Promise((resolve, reject) => {
      this.queue.push({
        requestKey: dialogRequestKey(viewModel.plan.planId, viewModel.plan.binding),
        viewModel,
        request,
        resolve,
        reject,
      })
      this.pump()
    })
  }

  /** Cancels only the exact Host plan/binding, whether active or still queued. */
  cancel(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void {
    const requestKey = dialogRequestKey(planId, binding)
    const cancelled = Object.freeze({ status: 'cancelled' as const })
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index]
      if (queued?.requestKey !== requestKey) continue
      this.queue.splice(index, 1)
      queued.resolve(cancelled)
    }
    if (this.active?.requestKey === requestKey) this.active.finish(cancelled)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const cancelled = Object.freeze({ status: 'cancelled' as const })
    for (const queued of this.queue.splice(0)) queued.resolve(cancelled)
    this.active?.finish(Object.freeze({ status: 'cancelled' }))
    if (this.ownsTheme) this.theme.dispose()
  }

  private pump(): void {
    if (this.disposed || this.active !== undefined) return
    const queued = this.queue.shift()
    if (queued === undefined) return
    void this.open(queued.viewModel, queued.request, queued.requestKey).then(
      queued.resolve,
      queued.reject,
    ).finally(() => this.pump())
  }

  private open(
    viewModel: PermissionAuthorizationViewModel,
    request: PermissionAuthorizationDialogRequest,
    requestKey: string,
  ): Promise<PermissionAuthorizationDialogResult> {
    if (this.disposed) return Promise.resolve(Object.freeze({ status: 'cancelled' }))
    return new Promise(resolve => {
      const HTMLElementConstructor = this.document.defaultView?.HTMLElement
      const previousFocus = HTMLElementConstructor !== undefined && this.document.activeElement instanceof HTMLElementConstructor
        ? this.document.activeElement as HTMLElement
        : undefined
      const initial = viewModel.project(request.project())
      const overlay = element(this.document, 'div', 'cxp-overlay cxf-scope')
      const forms = new HostFormAdapter(this.document, overlay, () => this.document.documentElement.lang || 'zh-CN')
      overlay.dataset.permissionAuthorization = viewModel.plan.planId
      noDrag(overlay)
      const detachTheme = this.theme.attach(overlay)
      const style = element(this.document, 'style')
      style.dataset.permissionAuthorizationStyle = 'true'
      style.textContent = STYLE
      const dialog = element(this.document, 'section', 'cxp-dialog')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      noDrag(dialog)

      const header = element(this.document, 'header', 'cxp-header')
      const icon = createHostSurfaceIcon(this.document, initial.plugin.icon)
      icon.classList.add('cxp-icon')
      const headerCopy = element(this.document, 'div', 'cxp-header-copy')
      const heading = element(this.document, 'h2', 'cxp-title', initial.heading)
      heading.id = `cxp-heading-${viewModel.plan.planId.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`
      dialog.setAttribute('aria-labelledby', heading.id)
      const pluginName = element(this.document, 'p', 'cxp-plugin-name', initial.plugin.name)
      const pluginMeta = element(this.document, 'dl', 'cxp-plugin-meta')
      const sourceLabel = element(this.document, 'dt', undefined, initial.plugin.sourceLabel)
      const sourceValue = element(this.document, 'dd', undefined, initial.plugin.source)
      const trustLabel = element(this.document, 'dt', undefined, initial.plugin.trustLabel)
      const trustValue = element(this.document, 'dd', undefined, initial.plugin.trust)
      pluginMeta.append(sourceLabel, sourceValue, trustLabel, trustValue)
      headerCopy.append(heading, pluginName, pluginMeta)
      header.append(icon, headerCopy)

      const list = element(this.document, 'div', 'cxp-list')
      list.setAttribute('role', 'list')
      const mounted = new Map<CordisXPermissionCapabilityV4, MountedItem>()
      for (const projected of initial.items) {
        const item = this.mountItem(viewModel, projected)
        mounted.set(projected.capability, item.mounted)
        list.append(item.root)
      }

      const actions = element(this.document, 'footer', 'cxp-actions cxf-actions')
      const manage = forms.button(initial.actions.manage)
      manage.classList.add('cxp-button', 'cxp-manage')
      manage.dataset.permissionAction = 'manage'
      const cancel = forms.button(initial.actions.cancel)
      cancel.classList.add('cxp-button')
      cancel.dataset.permissionAction = 'cancel'
      const confirm = forms.button(initial.actions.confirm, { variant: 'primary' })
      confirm.classList.add('cxp-button')
      confirm.dataset.permissionAction = 'confirm'
      confirm.dataset.primary = 'true'
      actions.append(manage, cancel, confirm)
      dialog.append(header, list, actions)
      overlay.append(style, dialog)

      let finished = false
      let unsubscribeLocale: (() => void) | undefined
      const finish = (result: PermissionAuthorizationDialogResult): void => {
        if (finished) return
        finished = true
        unsubscribeLocale?.()
        detachTheme()
        overlay.remove()
        if (this.active?.finish === finish) this.active = undefined
        if (previousFocus?.isConnected) previousFocus.focus()
        resolve(result)
      }
      this.active = { requestKey, finish }
      manage.addEventListener('click', () => finish(viewModel.managePermissions()), { once: true })
      cancel.addEventListener('click', () => finish(viewModel.cancel()), { once: true })
      confirm.addEventListener('click', () => finish(viewModel.confirm()), { once: true })
      overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          finish(viewModel.cancel())
          return
        }
        if (event.key !== 'Tab') return
        const candidates = focusable(dialog)
        const first = candidates[0]
        const last = candidates.at(-1)
        if (first === undefined || last === undefined) return
        if (event.shiftKey && this.document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && this.document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      })
      unsubscribeLocale = request.subscribeLocale?.(() => {
        if (finished) return
        const projection = viewModel.project(request.project())
        this.patch(initial, projection, {
          heading, pluginName, sourceLabel, sourceValue, trustLabel, trustValue,
          mounted, manage, cancel, confirm,
        })
      })
      this.document.body.append(overlay)
      const selected = dialog.querySelector<HTMLElement>('t-radio[aria-checked="true"]')
      ;(selected ?? confirm).focus()
    })
  }

  private mountItem(
    viewModel: PermissionAuthorizationViewModel,
    projected: PermissionAuthorizationItemProjection,
  ): { readonly root: HTMLElement; readonly mounted: MountedItem } {
    const root = element(this.document, 'section', 'cxp-item')
    root.setAttribute('role', 'listitem')
    root.dataset.permissionCapability = projected.capability
    const heading = element(this.document, 'div', 'cxp-item-heading')
    const name = element(this.document, 'h3', undefined, projected.name)
    const requirement = element(this.document, 'span', 'cxp-badge', projected.requirement)
    const sensitivity = element(this.document, 'span', 'cxp-badge', projected.sensitivity)
    sensitivity.dataset.risk = viewModel.plan.declarations.find(item => item.capability === projected.capability)!.sensitivity
    const reviewMode = element(this.document, 'span', 'cxp-badge', projected.reviewModeLabel)
    reviewMode.dataset.permissionReviewMode = projected.reviewMode
    heading.append(name, requirement, sensitivity, reviewMode)
    const facts = element(this.document, 'dl', 'cxp-facts')
    const descriptionLabel = element(this.document, 'dt', undefined, projected.descriptionLabel)
    const description = element(this.document, 'dd', undefined, projected.description)
    const limitationLabel = element(this.document, 'dt', undefined, projected.limitationLabel)
    const limitation = element(this.document, 'dd', undefined, projected.limitation)
    const scopeLabel = element(this.document, 'dt', undefined, projected.scopeLabel)
    const scope = element(this.document, 'dd', undefined, projected.scope)
    facts.append(descriptionLabel, description, limitationLabel, limitation, scopeLabel, scope)
    const risk = element(this.document, 'p', 'cxp-risk', projected.risk)
    risk.dataset.risk = sensitivity.dataset.risk
    const availability = projected.availability === undefined ? undefined : element(
      this.document,
      'p',
      'cxp-availability',
      `${projected.availability.statusLabel} · ${projected.availability.reason}`,
    )
    const rationale = projected.rationale === undefined ? undefined : this.mountRationale(projected)
    const decisions = element(this.document, 'fieldset', 'cxp-decisions')
    const authorizationLabel = element(this.document, 'legend', undefined, projected.authorizationLabel)
    const optionsRoot = element(this.document, 'div', 'cxp-options cxf-radio-group')
    const options = new Map<CordisXPermissionDecisionV2, { input: TDesignElement; label: HTMLElement }>()
    for (const option of projected.authorizationOptions) {
      const optionLabel = element(this.document, 'div', 'cxp-option cxf-choice')
      const input = createTDesignElement(this.document, 't-radio', 'radio')
      input.tabIndex = option.selected ? 0 : -1
      input.dataset.permissionDecision = option.value
      input.setAttribute('role', 'radio')
      input.setAttribute('aria-checked', String(option.selected))
      const label = element(this.document, 'span', undefined, option.label)
      const choose = (): void => {
        viewModel.select(projected.capability, option.value)
        for (const [value, mounted] of options) {
          const checked = value === option.value
          mounted.input.checked = checked
          mounted.input.tabIndex = checked ? 0 : -1
          mounted.input.setAttribute('aria-checked', String(checked))
          mounted.input.update?.()
        }
        denialImpact.hidden = !option.value.startsWith('deny')
      }
      setTDesignProps(input, {
        name: `cxp-${viewModel.plan.planId}-${projected.capability}`,
        value: option.value,
        checked: option.selected,
        onChange: (checked: boolean) => { if (checked) choose() },
      })
      input.addEventListener('click', choose)
      optionLabel.addEventListener('click', event => {
        if (event.target === input) return
        choose()
        input.focus()
      })
      optionLabel.append(input, label)
      options.set(option.value, { input, label })
      optionsRoot.append(optionLabel)
    }
    decisions.append(authorizationLabel, optionsRoot)
    const selected = projected.authorizationOptions.find(option => option.selected)?.value
    const denialImpact = element(this.document, 'p', 'cxp-denial', projected.denialImpact)
    denialImpact.hidden = selected?.startsWith('deny') !== true
    denialImpact.setAttribute('aria-live', 'polite')
    const technical = this.mountTechnical(projected)
    root.append(heading, facts, risk)
    if (availability !== undefined) root.append(availability)
    if (rationale !== undefined) root.append(rationale.root)
    root.append(decisions, denialImpact, technical.root)
    return {
      root,
      mounted: {
        capability: projected.capability,
        name, requirement, sensitivity, reviewMode, descriptionLabel, description, risk, limitationLabel, limitation, scopeLabel, scope,
        ...(availability === undefined ? {} : { availability }),
        ...(rationale === undefined ? {} : { rationale: rationale.mounted }),
        authorizationLabel,
        options,
        denialImpact,
        ...technical.mounted,
      },
    }
  }

  private mountRationale(projected: PermissionAuthorizationItemProjection): {
    readonly root: HTMLElement
    readonly mounted: NonNullable<MountedItem['rationale']>
  } {
    const rationale = projected.rationale!
    const root = element(this.document, 'section', 'cxp-rationale')
    const label = element(this.document, 'p', 'cxp-rationale-label', rationale.label)
    const title = element(this.document, 'p', 'cxp-rationale-title', rationale.title)
    const description = element(this.document, 'p', 'cxp-rationale-description', rationale.description)
    const facts = element(this.document, 'dl')
    const featureLabel = element(this.document, 'dt', undefined, rationale.featureLabel)
    const feature = element(this.document, 'dd', undefined, rationale.feature)
    const deniedBehaviorLabel = element(this.document, 'dt', undefined, rationale.deniedBehaviorLabel)
    const deniedBehavior = element(this.document, 'dd', undefined, rationale.deniedBehavior)
    facts.append(featureLabel, feature, deniedBehaviorLabel, deniedBehavior)
    root.append(label, title, description, facts)
    return { root, mounted: { label, title, description, featureLabel, feature, deniedBehaviorLabel, deniedBehavior } }
  }

  private mountTechnical(projected: PermissionAuthorizationItemProjection): {
    readonly root: HTMLDetailsElement
    readonly mounted: Pick<MountedItem,
      'technicalSummary' | 'capabilityLabel' | 'capabilityValue' | 'providersLabel' | 'providersValue'
      | 'runtimeLabel' | 'runtimeValue' | 'moduleLabel' | 'moduleValue' | 'requestLabel' | 'requestValue'>
  } {
    const value = projected.technical
    const root = element(this.document, 'details', 'cxp-technical')
    const technicalSummary = element(this.document, 'summary', undefined, value.label)
    const facts = element(this.document, 'dl')
    const capabilityLabel = element(this.document, 'dt', undefined, value.capabilityIdLabel)
    const capabilityValue = element(this.document, 'dd', undefined, value.capabilityId)
    const providersLabel = element(this.document, 'dt', undefined, value.providersLabel)
    const providersValue = element(this.document, 'dd', undefined, value.providers.join(', ') || '—')
    const runtimeLabel = element(this.document, 'dt', undefined, value.runtimeGenerationLabel)
    const runtimeValue = element(this.document, 'dd', undefined, value.runtimeGeneration)
    const moduleLabel = element(this.document, 'dt', undefined, value.moduleGenerationLabel)
    const moduleValue = element(this.document, 'dd', undefined, value.moduleGeneration ?? '—')
    const requestLabel = element(this.document, 'dt', undefined, value.requestSourceLabel)
    const requestValue = element(this.document, 'dd', undefined, value.requestSource ?? '—')
    facts.append(
      capabilityLabel, capabilityValue, providersLabel, providersValue, runtimeLabel, runtimeValue,
      moduleLabel, moduleValue, requestLabel, requestValue,
    )
    root.append(technicalSummary, facts)
    return {
      root,
      mounted: {
        technicalSummary, capabilityLabel, capabilityValue, providersLabel, providersValue,
        runtimeLabel, runtimeValue, moduleLabel, moduleValue, requestLabel, requestValue,
      },
    }
  }

  private patch(
    previous: PermissionAuthorizationDialogProjection,
    next: PermissionAuthorizationDialogProjection,
    mounted: {
      readonly heading: HTMLElement
      readonly pluginName: HTMLElement
      readonly sourceLabel: HTMLElement
      readonly sourceValue: HTMLElement
      readonly trustLabel: HTMLElement
      readonly trustValue: HTMLElement
      readonly mounted: ReadonlyMap<CordisXPermissionCapabilityV4, MountedItem>
      readonly manage: TDesignButtonElement
      readonly cancel: TDesignButtonElement
      readonly confirm: TDesignButtonElement
    },
  ): void {
    if (previous.items.length !== next.items.length) throw new Error('locale projection changed the permission plan shape')
    text(mounted.heading, next.heading)
    text(mounted.pluginName, next.plugin.name)
    text(mounted.sourceLabel, next.plugin.sourceLabel)
    text(mounted.sourceValue, next.plugin.source)
    text(mounted.trustLabel, next.plugin.trustLabel)
    text(mounted.trustValue, next.plugin.trust)
    setTDesignText(mounted.manage, next.actions.manage)
    setTDesignText(mounted.cancel, next.actions.cancel)
    setTDesignText(mounted.confirm, next.actions.confirm)
    for (const projected of next.items) {
      const item = mounted.mounted.get(projected.capability)
      if (item === undefined) throw new Error('locale projection changed the permission plan identity')
      text(item.name, projected.name)
      text(item.requirement, projected.requirement)
      text(item.sensitivity, projected.sensitivity)
      text(item.reviewMode, projected.reviewModeLabel)
      text(item.descriptionLabel, projected.descriptionLabel)
      text(item.description, projected.description)
      text(item.risk, projected.risk)
      text(item.limitationLabel, projected.limitationLabel)
      text(item.limitation, projected.limitation)
      text(item.scopeLabel, projected.scopeLabel)
      text(item.scope, projected.scope)
      if (item.availability !== undefined && projected.availability !== undefined) {
        text(item.availability, `${projected.availability.statusLabel} · ${projected.availability.reason}`)
      }
      if (item.rationale !== undefined && projected.rationale !== undefined) {
        text(item.rationale.label, projected.rationale.label)
        text(item.rationale.title, projected.rationale.title)
        text(item.rationale.description, projected.rationale.description)
        text(item.rationale.featureLabel, projected.rationale.featureLabel)
        text(item.rationale.feature, projected.rationale.feature)
        text(item.rationale.deniedBehaviorLabel, projected.rationale.deniedBehaviorLabel)
        text(item.rationale.deniedBehavior, projected.rationale.deniedBehavior)
      }
      text(item.authorizationLabel, projected.authorizationLabel)
      for (const option of projected.authorizationOptions) {
        const mountedOption = item.options.get(option.value)
        if (mountedOption === undefined) throw new Error('locale projection changed allowed permission decisions')
        text(mountedOption.label, option.label)
        mountedOption.input.checked = option.selected
        mountedOption.input.tabIndex = option.selected ? 0 : -1
        mountedOption.input.setAttribute('aria-checked', String(option.selected))
        mountedOption.input.update?.()
      }
      text(item.denialImpact, projected.denialImpact)
      item.denialImpact.hidden = !projected.authorizationOptions.find(option => option.selected)?.value.startsWith('deny')
      text(item.technicalSummary, projected.technical.label)
      text(item.capabilityLabel, projected.technical.capabilityIdLabel)
      text(item.capabilityValue, projected.technical.capabilityId)
      text(item.providersLabel, projected.technical.providersLabel)
      text(item.providersValue, projected.technical.providers.join(', ') || '—')
      text(item.runtimeLabel, projected.technical.runtimeGenerationLabel)
      text(item.runtimeValue, projected.technical.runtimeGeneration)
      text(item.moduleLabel, projected.technical.moduleGenerationLabel)
      text(item.moduleValue, projected.technical.moduleGeneration ?? '—')
      text(item.requestLabel, projected.technical.requestSourceLabel)
      text(item.requestValue, projected.technical.requestSource ?? '—')
    }
  }
}
