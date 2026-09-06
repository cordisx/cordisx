import { CORDISX_PLATFORM_CAPABILITIES } from '../../contracts.js'
import type {
  CordisXCapabilityDeclaration,
  CordisXPermissionDecision,
  CordisXPermissionPolicy,
  CordisXPermissionPolicyRecordV1,
  CordisXPlatformCapability,
  CordisXPlatformModelRef,
  CordisXPlatformSessionRef,
  CordisXPluginIdentity,
} from '../../contracts.js'
import { HostThemeProjection } from '../host-theme.js'
import { PermissionAuthorizationViewModel } from '../../permission-authorization-view-model.js'
import type { PermissionAuthorizationProjectionInput } from '../../permission-authorization-view-model.js'
import { BrowserPermissionAuthorizationDialog } from '../permission-authorization-dialog.js'
import type {
  CordisXPermissionAuthorizationBindingV2,
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV3,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV3,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionPolicyRecordV2,
  CordisXPermissionPolicyRecordV3,
  CordisXPermissionPolicyRecordV4,
} from '../../permission-contracts.js'
import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  isPermissionPolicyRecordV4,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionMigrationKey,
  persistedPermissionRecordKey,
} from '../../permission-persistence.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../../permission-persistence.js'

import { copy, LEGACY_POLICY_STORAGE_KEY, object, POLICY_STORAGE_KEY } from './platform-manifest.js'

export interface LegacyStoredPolicy {
  readonly identityKey: string
  readonly capability: CordisXPlatformCapability
  readonly fingerprint: string
  readonly policy: CordisXPermissionPolicy
}

export interface PermissionPolicyStore {
  read(): readonly CordisXPermissionPolicyRecordV1[]
  write(records: readonly CordisXPermissionPolicyRecordV1[]): void | Promise<void>
  readV2?(): readonly CordisXPermissionPolicyRecordV2[]
  writeV2?(records: readonly CordisXPermissionPolicyRecordV2[]): void | Promise<void>
  readV3?(): readonly CordisXPermissionPolicyRecordV3[]
  writeV3?(records: readonly CordisXPermissionPolicyRecordV3[]): void | Promise<void>
  readV4?(): readonly CordisXPermissionPolicyRecordV4[]
  writeV4?(records: readonly CordisXPermissionPolicyRecordV4[]): void | Promise<void>
  /** One atomic write for mixed-version records in the single profile ledger. */
  writeAll?(records: readonly CordisXPersistedPermissionPolicyRecord[]): void | Promise<void>
  legacy?(): readonly LegacyStoredPolicy[]
  retireLegacy?(record: LegacyStoredPolicy): void | Promise<void>
}

export class MemoryPermissionPolicyStore implements PermissionPolicyStore {
  records: readonly CordisXPersistedPermissionPolicyRecord[]

  constructor(
    records: readonly CordisXPermissionPolicyRecordV1[] = [],
    recordsV2: readonly CordisXPermissionPolicyRecordV2[] = [],
    recordsV3: readonly CordisXPermissionPolicyRecordV3[] = [],
    recordsV4: readonly CordisXPermissionPolicyRecordV4[] = [],
  ) {
    this.records = copy([...records, ...recordsV2, ...recordsV3, ...recordsV4])
  }

  read(): readonly CordisXPermissionPolicyRecordV1[] {
    return copy(
      this.records.filter(record =>
        !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record)
        && !isPermissionPolicyRecordV4(record)
      ),
    ) as readonly CordisXPermissionPolicyRecordV1[]
  }

  readV2(): readonly CordisXPermissionPolicyRecordV2[] {
    return copy(this.records.filter(isPermissionPolicyRecordV2))
  }

  readV3(): readonly CordisXPermissionPolicyRecordV3[] {
    return copy(this.records.filter(isPermissionPolicyRecordV3))
  }

  readV4(): readonly CordisXPermissionPolicyRecordV4[] {
    return copy(this.records.filter(isPermissionPolicyRecordV4))
  }

  write(records: readonly CordisXPermissionPolicyRecordV1[]): void {
    this.writeRecords(records)
  }

  writeV2(records: readonly CordisXPermissionPolicyRecordV2[]): void {
    this.writeRecords(records)
  }

  writeV3(records: readonly CordisXPermissionPolicyRecordV3[]): void {
    this.writeRecords(records)
  }

  writeV4(records: readonly CordisXPermissionPolicyRecordV4[]): void {
    this.writeRecords(records)
  }

  writeAll(records: readonly CordisXPersistedPermissionPolicyRecord[]): void {
    this.writeRecords(records)
  }

  private writeRecords(records: readonly CordisXPersistedPermissionPolicyRecord[]): void {
    const normalized = records.map(item => normalizePersistedPermissionPolicyRecord(item))
    const keys = new Set(normalized.map(persistedPermissionRecordKey))
    const migrations = new Set(normalized.filter(isPermissionPolicyRecordV2).map(persistedPermissionMigrationKey))
    this.records = copy([
      ...this.records.filter(item =>
        !keys.has(persistedPermissionRecordKey(item))
        && !(migrations.has(persistedPermissionMigrationKey(item)) && !isPermissionPolicyRecordV2(item))
      ),
      ...normalized,
    ])
  }
}

export class BrowserPermissionPolicyStore implements PermissionPolicyStore {
  constructor(private readonly profileId = 'default') {}

  read(): readonly CordisXPermissionPolicyRecordV1[] {
    return this.readAll().filter((record): record is CordisXPermissionPolicyRecordV1 => (
      !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record) && !isPermissionPolicyRecordV4(record)
      && record.key.profileId === this.profileId
    ))
  }

  readV2(): readonly CordisXPermissionPolicyRecordV2[] {
    return this.readAll().filter((record): record is CordisXPermissionPolicyRecordV2 => (
      isPermissionPolicyRecordV2(record) && record.key.profileId === this.profileId
    ))
  }

  readV3(): readonly CordisXPermissionPolicyRecordV3[] {
    return this.readAll().filter((record): record is CordisXPermissionPolicyRecordV3 => (
      isPermissionPolicyRecordV3(record) && record.key.profileId === this.profileId
    ))
  }

  readV4(): readonly CordisXPermissionPolicyRecordV4[] {
    return this.readAll().filter((record): record is CordisXPermissionPolicyRecordV4 => (
      isPermissionPolicyRecordV4(record) && record.key.profileId === this.profileId
    ))
  }

  write(nextRecords: readonly CordisXPermissionPolicyRecordV1[]): void {
    this.writeRecords(nextRecords)
  }

  writeV2(nextRecords: readonly CordisXPermissionPolicyRecordV2[]): void {
    this.writeRecords(nextRecords)
  }

  writeV3(nextRecords: readonly CordisXPermissionPolicyRecordV3[]): void {
    this.writeRecords(nextRecords)
  }

  writeV4(nextRecords: readonly CordisXPermissionPolicyRecordV4[]): void {
    this.writeRecords(nextRecords)
  }

  writeAll(nextRecords: readonly CordisXPersistedPermissionPolicyRecord[]): void {
    this.writeRecords(nextRecords)
  }

  private readAll(): readonly CordisXPersistedPermissionPolicyRecord[] {
    try {
      const value = localStorage.getItem(POLICY_STORAGE_KEY)
      const parsed = value === null ? [] : JSON.parse(value) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((item) => {
        try {
          return [normalizePersistedPermissionPolicyRecord(item)]
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  }

  private writeRecords(nextRecords: readonly CordisXPersistedPermissionPolicyRecord[]): void {
    const normalized = nextRecords.map(item => normalizePersistedPermissionPolicyRecord(item))
    const records = this.readAll()
    const keys = new Set(normalized.map(persistedPermissionRecordKey))
    const migrations = new Set(normalized.filter(isPermissionPolicyRecordV2).map(persistedPermissionMigrationKey))
    localStorage.setItem(
      POLICY_STORAGE_KEY,
      JSON.stringify([
        ...records.filter(item =>
          !keys.has(persistedPermissionRecordKey(item))
          && !(migrations.has(persistedPermissionMigrationKey(item)) && !isPermissionPolicyRecordV2(item))
        ),
        ...normalized,
      ]),
    )
  }

  legacy(): readonly LegacyStoredPolicy[] {
    try {
      const value = localStorage.getItem(LEGACY_POLICY_STORAGE_KEY)
      if (value === null) return []
      const records = JSON.parse(value) as unknown
      if (!Array.isArray(records)) return []
      return records.filter((item): item is LegacyStoredPolicy => {
        if (item === null || typeof item !== 'object') return false
        const record = item as Partial<LegacyStoredPolicy>
        return typeof record.identityKey === 'string'
          && typeof record.capability === 'string'
          && (CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(record.capability)
          && typeof record.fingerprint === 'string'
          && (record.policy === 'ask' || record.policy === 'deny' || record.policy === 'allow')
      })
    } catch {
      return []
    }
  }

  retireLegacy(record: LegacyStoredPolicy): void {
    try {
      const records = this.legacy()
      const retained = records.filter(item => JSON.stringify(item) !== JSON.stringify(record))
      if (retained.length === 0) localStorage.removeItem(LEGACY_POLICY_STORAGE_KEY)
      else localStorage.setItem(LEGACY_POLICY_STORAGE_KEY, JSON.stringify(retained))
    } catch {
      // A stale legacy record is safe: exact migration is idempotent.
    }
  }
}

export interface RequestedScope {
  readonly providerId?: string
  readonly providerIds?: readonly string[]
  readonly cwd?: string
  readonly model?: CordisXPlatformModelRef
  readonly session?: CordisXPlatformSessionRef
  readonly adapterGeneration?: string
  readonly agentSessionId?: string
  readonly allAgentSessions?: true
}

export interface PermissionPromptRequest {
  readonly identity: CordisXPluginIdentity
  readonly declaration: CordisXCapabilityDeclaration
  readonly requested: RequestedScope
  readonly signal?: AbortSignal
}

export interface PermissionPrompt {
  request(input: PermissionPromptRequest): Promise<Exclude<CordisXPermissionDecision, 'ask'>>
}

export interface PermissionAuthorizationPromptV2 {
  request(
    plan: CordisXPermissionAuthorizationPlanV2,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV2 | undefined>
  requestV3?(
    plan: CordisXPermissionAuthorizationPlanV3,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV3 | undefined>
  cancelV3?(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void
  requestV4?(
    plan: CordisXPermissionAuthorizationPlanV4,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV4 | undefined>
  cancelV4?(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void
  dispose?(): void
}

export class BrowserPermissionPrompt implements PermissionPrompt {
  private queue = Promise.resolve()
  private readonly theme: HostThemeProjection

  constructor(private readonly document: Document | undefined = globalThis.document) {
    this.theme = new HostThemeProjection(document ?? globalThis.document)
  }

  request(input: PermissionPromptRequest): Promise<Exclude<CordisXPermissionDecision, 'ask'>> {
    const next = this.queue.then(async () => input.signal?.aborted === true ? 'deny' : await this.show(input))
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async show(input: PermissionPromptRequest): Promise<Exclude<CordisXPermissionDecision, 'ask'>> {
    const document = this.document
    if (document?.body === undefined || input.signal?.aborted === true) return 'deny'
    const reason = input.declaration.reason.fallback
      ?? `${input.declaration.reason.namespace ?? input.identity.id}:${input.declaration.reason.key}`
    return await new Promise((resolve) => {
      const overlay = document.createElement('div')
      const detachTheme = this.theme.attach(overlay)
      overlay.dataset.permissionPrompt = input.declaration.name
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.setAttribute('aria-labelledby', 'cordisx-permission-prompt-title')
      overlay.setAttribute('aria-describedby', 'cordisx-permission-prompt-description')
      overlay.innerHTML = `<style>
        [data-permission-prompt] { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; background: var(--cx-backdrop); }
        [data-permission-prompt] .cxp-dialog { width: min(460px, 100%); border: 1px solid var(--cx-border); border-radius: 14px; padding: 20px; background: var(--cx-surface-raised); color: var(--cx-text); box-shadow: 0 20px 64px var(--cx-shadow); }
        [data-permission-prompt] h2 { margin: 0; font-size: 18px; }
        [data-permission-prompt] p { margin: 10px 0 0; line-height: 1.5; }
        [data-permission-prompt] .cxp-reason { color: var(--cx-muted); }
        [data-permission-prompt] .cxp-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 20px; }
        [data-permission-prompt] button { border: 1px solid var(--cx-border); border-radius: 9px; padding: 8px 12px; background: var(--cx-hover); color: var(--cx-text); cursor: pointer; }
        [data-permission-prompt] button[data-primary="true"] { border-color: var(--cx-primary); background: var(--cx-primary); color: var(--cx-primary-text); font-weight: 600; }
        [data-permission-prompt] button[data-tone="danger"] { color: var(--cx-danger); }
        [data-permission-prompt] button:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 2px; }
      </style>`
      const dialog = document.createElement('div')
      dialog.className = 'cxp-dialog'
      const title = document.createElement('h2')
      title.id = 'cordisx-permission-prompt-title'
      title.textContent = '权限请求'
      const description = document.createElement('p')
      description.id = 'cordisx-permission-prompt-description'
      description.textContent = `${input.identity.id} 请求 ${input.declaration.name}`
      const reasonNode = document.createElement('p')
      reasonNode.className = 'cxp-reason'
      reasonNode.textContent = reason
      const actions = document.createElement('div')
      actions.className = 'cxp-actions'
      let settled = false
      const finish = (decision: Exclude<CordisXPermissionDecision, 'ask'>): void => {
        if (settled) return
        settled = true
        input.signal?.removeEventListener('abort', abort)
        detachTheme()
        overlay.remove()
        resolve(decision)
      }
      const abort = (): void => finish('deny')
      input.signal?.addEventListener('abort', abort, { once: true })
      const deny = document.createElement('button')
      deny.type = 'button'
      deny.dataset.permissionDecision = 'deny'
      deny.dataset.tone = 'danger'
      deny.textContent = '拒绝'
      deny.addEventListener('click', () => finish('deny'), { once: true })
      const once = document.createElement('button')
      once.type = 'button'
      once.dataset.permissionDecision = 'allow-once'
      once.textContent = '仅此次允许'
      once.addEventListener('click', () => finish('allow-once'), { once: true })
      const allow = document.createElement('button')
      allow.type = 'button'
      allow.dataset.permissionDecision = 'allow'
      allow.dataset.primary = 'true'
      allow.textContent = '始终允许'
      allow.addEventListener('click', () => finish('allow'), { once: true })
      overlay.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        finish('deny')
      })
      actions.append(deny, once, allow)
      dialog.append(title, description, reasonNode, actions)
      overlay.append(dialog)
      document.body.append(overlay)
      allow.focus()
    })
  }
}

export type PermissionAuthorizationProjectionFactoryV2 = (
  plan: CordisXPermissionAuthorizationPlanV2,
  identity: CordisXPluginIdentity,
) => PermissionAuthorizationProjectionInput

/** Host-owned v2 modal; plugin text is already validated and only reaches text nodes. */
export class BrowserPermissionAuthorizationPromptV2 implements PermissionAuthorizationPromptV2 {
  private readonly dialog: BrowserPermissionAuthorizationDialog

  constructor(
    document: Document = globalThis.document,
    private readonly project: PermissionAuthorizationProjectionFactoryV2 = (_plan, identity) => ({
      plugin: { name: identity.id, source: identity.source, trust: 'configured' },
      availability: {},
      resolve: message => message.fallback ?? `[[${message.namespace ?? 'permission'}:${message.key}]]`,
      scope: scope => Object.keys(scope).length === 0 ? 'Host default scope' : JSON.stringify(scope),
      requestSource: identity.source,
    }),
  ) {
    this.dialog = new BrowserPermissionAuthorizationDialog(document)
  }

  async request(
    plan: CordisXPermissionAuthorizationPlanV2,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV2 | undefined> {
    const result = await this.dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => this.project(plan, identity),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 2 ? result.decision : undefined
  }

  async requestV3(
    plan: CordisXPermissionAuthorizationPlanV3,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV3 | undefined> {
    const result = await this.dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => this.project(plan as unknown as CordisXPermissionAuthorizationPlanV2, identity),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
  }

  async requestV4(
    plan: CordisXPermissionAuthorizationPlanV4,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV4 | undefined> {
    const result = await this.dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => this.project(plan as unknown as CordisXPermissionAuthorizationPlanV2, identity),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 4 ? result.decision : undefined
  }

  cancelV3(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void {
    this.dialog.cancel(planId, binding)
  }

  cancelV4(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void {
    this.dialog.cancel(planId, binding)
  }

  dispose(): void {
    this.dialog.dispose()
  }
}
