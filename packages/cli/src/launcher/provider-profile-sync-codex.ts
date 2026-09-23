import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { parse, type TomlTable, type TomlValue } from 'smol-toml'
import {
  parseProviderSyncBinding,
  parseProviderSyncConnection,
  parseProviderSyncTargetProfileRef,
  providerSyncAdapterCapabilities,
  type ProviderSyncBindingDefinition,
  type ProviderSyncConnectionDefinition,
  type ProviderSyncDiagnostic,
  type ProviderSyncNativeConnection,
  type ProviderSyncProfileProjection,
  type ProviderSyncResult,
  type ProviderSyncTargetProfileRef,
  targetProfileRefKey,
} from './provider-profile-sync-contracts.js'
import {
  ProviderProfileSyncLedgerStore,
  type ProviderSyncBindingLedgerEntry,
  type ProviderSyncFieldGroups,
  type ProviderSyncLedger,
  providerSyncRevision,
} from './provider-profile-sync-ledger.js'
import { projectCodexProviderProfile } from './provider-profile-sync-projection.js'
import {
  applyCodexProviderTargetPlans,
  codexProviderTargetGroups,
  type CodexProviderWritableTargetSnapshot,
  codexTargetHasUnsupportedInlineProviders,
  readCodexProviderTarget,
} from './provider-profile-sync-codex-target.js'

type TargetSnapshot = CodexProviderWritableTargetSnapshot

interface BindingPlan {
  readonly binding: ProviderSyncBindingDefinition
  readonly connection: ProviderSyncConnectionDefinition
  readonly ledger?: ProviderSyncBindingLedgerEntry
  readonly desired: ProviderSyncFieldGroups
  readonly target: ProviderSyncFieldGroups
  readonly apply: readonly ('display' | 'routing')[]
  readonly skipped: readonly ('display' | 'routing')[]
  readonly diagnostics: readonly ProviderSyncDiagnostic[]
  readonly create: boolean
}

export interface SyncCodexProviderProfileOptions {
  readonly stateDir: string
  readonly targetProfileRef: ProviderSyncTargetProfileRef
  readonly connections: readonly ProviderSyncConnectionDefinition[]
  readonly bindings: readonly ProviderSyncBindingDefinition[]
  /** Test-only race seam called after staging and before the target CAS check. */
  readonly beforeCommit?: () => void | Promise<void>
  /** Test-only crash seam called after the target rename and before ledger commit. */
  readonly afterTargetCommit?: () => void | Promise<void>
}

function table(value: TomlValue | undefined): TomlTable | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    ? value as TomlTable
    : undefined
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, item]) => `${JSON.stringify(key)}:${stable(item)}`,
    ).join(',')
  }}`
}

function equal(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right)
}

function conflictFingerprint(
  bindingId: string,
  group: 'display' | 'routing',
  last: Readonly<Record<string, string | boolean>> | undefined,
  desired: Readonly<Record<string, string | boolean>> | undefined,
  target: Readonly<Record<string, string | boolean>> | undefined,
): string {
  return createHash('sha256').update(stable([bindingId, group, last, desired, target])).digest('hex')
}

function desiredGroups(
  connection: ProviderSyncConnectionDefinition,
  binding: ProviderSyncBindingDefinition,
): ProviderSyncFieldGroups {
  const envKey = providerSyncCredentialEnvironmentKey(binding.bindingId)
  return Object.freeze({
    display: Object.freeze({ name: binding.overlay?.title ?? connection.title }),
    routing: Object.freeze({
      base_url: connection.endpoint,
      wire_api: connection.protocol,
      env_key: envKey,
      auth_kind: 'environment',
    }),
  })
}

export function providerSyncCredentialEnvironmentKey(bindingId: string): string {
  return `CORDISX_PROVIDER_${createHash('sha256').update(bindingId).digest('hex').slice(0, 16).toUpperCase()}`
}

function planGroup(input: {
  readonly binding: ProviderSyncBindingDefinition
  readonly group: 'display' | 'routing'
  readonly last: Readonly<Record<string, string | boolean>> | undefined
  readonly desired: Readonly<Record<string, string | boolean>> | undefined
  readonly target: Readonly<Record<string, string | boolean>> | undefined
  readonly priorWarnings: readonly string[]
}): { readonly apply: boolean; readonly skipped: boolean; readonly diagnostic?: ProviderSyncDiagnostic } {
  if (equal(input.target, input.desired)) return { apply: false, skipped: false }
  if (input.last === undefined || equal(input.target, input.last)) return { apply: true, skipped: false }
  const fingerprint = conflictFingerprint(
    input.binding.bindingId,
    input.group,
    input.last,
    input.desired,
    input.target,
  )
  return {
    apply: false,
    skipped: true,
    diagnostic: Object.freeze({
      code: 'route-conflict',
      severity: 'warning',
      bindingId: input.binding.bindingId,
      localProviderId: input.binding.localProviderId,
      fieldGroup: input.group,
      fingerprint,
      notify: !input.priorWarnings.includes(fingerprint),
    }),
  }
}

function createBindingPlan(input: {
  readonly binding: ProviderSyncBindingDefinition
  readonly connection: ProviderSyncConnectionDefinition
  readonly ledger?: ProviderSyncBindingLedgerEntry
  readonly snapshot: TargetSnapshot
}): BindingPlan {
  const { binding, connection, ledger, snapshot } = input
  const desired = desiredGroups(connection, binding)
  const target = codexProviderTargetGroups(snapshot.config, binding.localProviderId)
  if (connection.protocol !== 'responses') {
    return Object.freeze({
      binding,
      connection,
      ...(ledger === undefined ? {} : { ledger }),
      desired,
      target,
      apply: Object.freeze([] as ('display' | 'routing')[]),
      skipped: Object.freeze(['routing'] as const),
      diagnostics: Object.freeze([Object.freeze(
        {
          code: 'unsupported-config-shape',
          severity: 'warning',
          bindingId: binding.bindingId,
          localProviderId: binding.localProviderId,
          fieldGroup: 'routing',
          notify: true,
        } satisfies ProviderSyncDiagnostic,
      )]),
      create: false,
    })
  }
  if (!binding.enabled || !connection.enabled) {
    return Object.freeze({
      binding,
      connection,
      ...(ledger === undefined ? {} : { ledger }),
      desired,
      target,
      apply: Object.freeze([] as ('display' | 'routing')[]),
      skipped: Object.freeze([] as ('display' | 'routing')[]),
      diagnostics: Object.freeze([Object.freeze(
        {
          code: 'binding-disabled',
          severity: 'info',
          bindingId: binding.bindingId,
          localProviderId: binding.localProviderId,
        } satisfies ProviderSyncDiagnostic,
      )]),
      create: false,
    })
  }
  if (ledger?.state === 'detached' || ledger?.state === 'tombstoned') {
    return Object.freeze({
      binding,
      connection,
      ledger,
      desired,
      target,
      apply: Object.freeze([] as ('display' | 'routing')[]),
      skipped: Object.freeze([] as ('display' | 'routing')[]),
      diagnostics: Object.freeze([Object.freeze(
        {
          code: 'binding-detached',
          severity: 'info',
          bindingId: binding.bindingId,
          localProviderId: binding.localProviderId,
        } satisfies ProviderSyncDiagnostic,
      )]),
      create: false,
    })
  }
  const exists = table(table(snapshot.config.model_providers)?.[binding.localProviderId]) !== undefined
  if (ledger === undefined && exists) {
    return Object.freeze({
      binding,
      connection,
      desired,
      target,
      apply: Object.freeze([] as ('display' | 'routing')[]),
      skipped: Object.freeze(['display', 'routing'] as const),
      diagnostics: Object.freeze([Object.freeze(
        {
          code: 'id-conflict',
          severity: 'warning',
          bindingId: binding.bindingId,
          localProviderId: binding.localProviderId,
          notify: true,
        } satisfies ProviderSyncDiagnostic,
      )]),
      create: false,
    })
  }
  const priorWarnings = ledger?.warningFingerprints ?? []
  const display = planGroup({
    binding,
    group: 'display',
    last: ledger?.lastApplied.display,
    desired: desired.display,
    target: target.display,
    priorWarnings,
  })
  const routing = planGroup({
    binding,
    group: 'routing',
    last: ledger?.lastApplied.routing,
    desired: desired.routing,
    target: target.routing,
    priorWarnings,
  })
  const decisions = { display, routing }
  return Object.freeze({
    binding,
    connection,
    ...(ledger === undefined ? {} : { ledger }),
    desired,
    target,
    apply: Object.freeze((['display', 'routing'] as const).filter(group => decisions[group].apply)),
    skipped: Object.freeze((['display', 'routing'] as const).filter(group => decisions[group].skipped)),
    diagnostics: Object.freeze(
      (['display', 'routing'] as const).flatMap(group =>
        decisions[group].diagnostic === undefined ? [] : [decisions[group].diagnostic]
      ),
    ),
    create: !exists,
  })
}

function updatedLedger(
  ledger: ProviderSyncLedger,
  plans: readonly BindingPlan[],
): ProviderSyncLedger {
  let changed = false
  const byId = new Map(ledger.bindings.map(binding => [binding.bindingId, binding]))
  for (const plan of plans) {
    const existing = byId.get(plan.binding.bindingId)
    if (existing === undefined && plan.diagnostics.some(item => item.code === 'id-conflict')) continue
    if (existing?.state === 'detached' || existing?.state === 'tombstoned') continue
    const warningFingerprints = Object.freeze([
      ...new Set([
        ...(existing?.warningFingerprints ?? []),
        ...plan.diagnostics.flatMap(item => item.fingerprint ?? []),
      ]),
    ])
    const lastApplied: ProviderSyncFieldGroups = Object.freeze({
      ...(plan.apply.includes('display') || equal(plan.target.display, plan.desired.display)
        ? { display: plan.desired.display }
        : existing?.lastApplied.display === undefined
        ? {}
        : { display: existing.lastApplied.display }),
      ...(plan.apply.includes('routing') || equal(plan.target.routing, plan.desired.routing)
        ? { routing: plan.desired.routing }
        : existing?.lastApplied.routing === undefined
        ? {}
        : { routing: existing.lastApplied.routing }),
    })
    const observedTarget: ProviderSyncFieldGroups = Object.freeze({
      ...(plan.apply.includes('display')
        ? plan.desired.display === undefined ? {} : { display: plan.desired.display }
        : plan.target.display === undefined
        ? {}
        : { display: plan.target.display }),
      ...(plan.apply.includes('routing')
        ? plan.desired.routing === undefined ? {} : { routing: plan.desired.routing }
        : plan.target.routing === undefined
        ? {}
        : { routing: plan.target.routing }),
    })
    const next: ProviderSyncBindingLedgerEntry = Object.freeze({
      bindingId: plan.binding.bindingId,
      connectionId: plan.connection.connectionId,
      targetProfileRef: plan.binding.targetProfileRef,
      localProviderId: plan.binding.localProviderId,
      ownership: existing?.ownership ?? 'created',
      state: 'managed',
      credentialDelivery: plan.binding.credentialDelivery,
      sourceRevision: plan.connection.revision,
      credentialRevision: plan.connection.credential.revision,
      ...(plan.binding.overlay === undefined ? {} : { overlay: plan.binding.overlay }),
      models: plan.connection.models,
      lastApplied,
      observedTarget,
      warningFingerprints,
      ...(existing?.importedFrom === undefined ? {} : { importedFrom: existing.importedFrom }),
    })
    if (!equal(existing, next)) changed = true
    byId.set(next.bindingId, next)
  }
  if (!changed) return ledger
  const known = new Set(ledger.bindings.map(binding => binding.bindingId))
  const bindings = ledger.bindings.map(binding => byId.get(binding.bindingId)!)
  for (const plan of plans) {
    if (!known.has(plan.binding.bindingId) && byId.has(plan.binding.bindingId)) {
      bindings.push(byId.get(plan.binding.bindingId)!)
      known.add(plan.binding.bindingId)
    }
  }
  return Object.freeze({ ...ledger, generation: ledger.generation + 1, bindings: Object.freeze(bindings) })
}

async function stageTarget(file: string, raw: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const stagedPath = path.join(path.dirname(file), `.provider-profile-${randomUUID()}.tmp`)
  const handle = await open(stagedPath, 'wx', 0o600)
  try {
    await handle.writeFile(raw)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return stagedPath
}

async function recover(store: ProviderProfileSyncLedgerStore): Promise<'none' | 'recovered' | 'required'> {
  const journal = await store.readJournal()
  if (journal === undefined) return 'none'
  const current = await readFile(journal.targetPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const revision = providerSyncRevision(current)
  if (revision === journal.afterRevision) {
    if (await store.commit(journal.ledger) !== 'applied') return 'required'
    await store.removeJournal()
    await rm(journal.stagedPath, { force: true })
    return 'recovered'
  }
  if (revision === journal.beforeRevision) {
    await store.removeJournal()
    await rm(journal.stagedPath, { force: true })
    return 'recovered'
  }
  return 'required'
}

export async function discoverCodexProviderProfile(
  value: ProviderSyncTargetProfileRef,
): Promise<ProviderSyncProfileProjection> {
  const target = parseProviderSyncTargetProfileRef(value)
  if (target.adapterId !== 'codex') {
    const diagnostic: ProviderSyncDiagnostic = Object.freeze({
      code: 'unsupported-adapter',
      severity: 'error',
    })
    return projectCodexProviderProfile({
      target,
      ledger: { version: 1, generation: 0, bindings: [], imports: [] },
      diagnostics: [diagnostic],
    })
  }
  try {
    const snapshot = await readCodexProviderTarget(target)
    return projectCodexProviderProfile({
      target,
      ...(snapshot === undefined ? {} : { snapshot }),
      ledger: { version: 1, generation: 0, bindings: [], imports: [] },
      diagnostics: [],
      runtime: Object.freeze({ status: 'not-running' as const }),
    })
  } catch {
    return Object.freeze({
      ...projectCodexProviderProfile({
        target,
        ledger: { version: 1, generation: 0, bindings: [], imports: [] },
        diagnostics: [],
      }),
      persisted: Object.freeze({ status: 'invalid' as const }),
      sync: Object.freeze({ status: 'failed' as const }),
      diagnostics: Object.freeze([Object.freeze(
        {
          code: 'config-invalid',
          severity: 'error',
        } satisfies ProviderSyncDiagnostic,
      )]),
    })
  }
}

export async function discoverCodexNativeConnections(
  value: ProviderSyncTargetProfileRef,
): Promise<readonly ProviderSyncNativeConnection[]> {
  const target = parseProviderSyncTargetProfileRef(value)
  if (target.adapterId !== 'codex') return Object.freeze([])
  const snapshot = await readCodexProviderTarget(target)
  if (snapshot === undefined) return Object.freeze([])
  const configured = table(snapshot.config.model_providers) ?? {}
  const activeProvider = typeof snapshot.config.model_provider === 'string' ? snapshot.config.model_provider : undefined
  const activeModel = typeof snapshot.config.model === 'string' ? snapshot.config.model : undefined
  return Object.freeze(
    Object.entries(configured).flatMap(([nativeLocalId, value]) => {
      const provider = table(value)
      if (provider === undefined || nativeLocalId === 'openai') return []
      const credential = typeof provider.env_key === 'string'
        ? { kind: 'environment' as const, reference: provider.env_key }
        : typeof provider.experimental_bearer_token === 'string'
        ? { kind: 'inline-private' as const }
        : provider.requires_openai_auth === false
        ? { kind: 'native' as const }
        : { kind: 'unknown' as const }
      return [Object.freeze({
        sourceKind: 'native' as const,
        sourceRef: JSON.stringify(['native', targetProfileRefKey(target), nativeLocalId]),
        targetProfileRef: target,
        nativeLocalId,
        title: typeof provider.name === 'string' ? provider.name : nativeLocalId,
        ...(typeof provider.base_url === 'string' ? { endpoint: provider.base_url } : {}),
        ...(provider.wire_api === 'responses' || provider.wire_api === 'chat-completions'
          ? { protocol: provider.wire_api }
          : {}),
        credential: Object.freeze(credential),
        ...(activeProvider === nativeLocalId && activeModel !== undefined ? { activeModelId: activeModel } : {}),
      })]
    }),
  )
}

export async function readCodexProviderProfile(input: {
  readonly stateDir: string
  readonly targetProfileRef: ProviderSyncTargetProfileRef
  readonly runtime?: ProviderSyncProfileProjection['runtime']
}): Promise<ProviderSyncProfileProjection> {
  const target = parseProviderSyncTargetProfileRef(input.targetProfileRef)
  const store = new ProviderProfileSyncLedgerStore(input.stateDir)
  const ledger = await store.read()
  let snapshot: TargetSnapshot | undefined
  try {
    snapshot = await readCodexProviderTarget(target)
  } catch {
    return Object.freeze({
      ...projectCodexProviderProfile({
        target,
        ledger,
        diagnostics: [],
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      }),
      persisted: Object.freeze({ status: 'invalid' as const }),
      sync: Object.freeze({ status: 'failed' as const }),
      diagnostics: Object.freeze([Object.freeze(
        {
          code: 'config-invalid',
          severity: 'error',
        } satisfies ProviderSyncDiagnostic,
      )]),
    })
  }
  return projectCodexProviderProfile({
    target,
    ...(snapshot === undefined ? {} : { snapshot }),
    ledger,
    diagnostics: [],
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
  })
}

export async function syncCodexProviderProfile(options: SyncCodexProviderProfileOptions): Promise<ProviderSyncResult> {
  const target = parseProviderSyncTargetProfileRef(options.targetProfileRef)
  const capabilities = providerSyncAdapterCapabilities(target.adapterId)
  const store = new ProviderProfileSyncLedgerStore(options.stateDir)
  let ledger = await store.read()
  if (!capabilities.managedSync || target.adapterId !== 'codex') {
    const diagnostic: ProviderSyncDiagnostic = Object.freeze({
      code: 'unsupported-adapter',
      severity: 'error',
    })
    return Object.freeze({
      targetProfileRef: target,
      targetChanged: false,
      ledgerChanged: false,
      appliedBindingIds: Object.freeze([]),
      diagnostics: Object.freeze([diagnostic]),
      projection: projectCodexProviderProfile({ target, ledger, diagnostics: [diagnostic] }),
    })
  }
  const recovery = await recover(store)
  if (recovery === 'required') {
    const diagnostic: ProviderSyncDiagnostic = Object.freeze({ code: 'recovery-required', severity: 'error' })
    return Object.freeze({
      targetProfileRef: target,
      targetChanged: false,
      ledgerChanged: false,
      appliedBindingIds: Object.freeze([]),
      diagnostics: Object.freeze([diagnostic]),
      projection: projectCodexProviderProfile({ target, ledger, diagnostics: [diagnostic] }),
    })
  }
  if (recovery === 'recovered') ledger = await store.read()
  let snapshot: TargetSnapshot
  try {
    snapshot = await readCodexProviderTarget(target) ?? Object.freeze({
      raw: '',
      revision: providerSyncRevision(''),
      config: Object.freeze({}),
      tables: new Map(),
    })
  } catch {
    const diagnostic: ProviderSyncDiagnostic = Object.freeze({ code: 'config-invalid', severity: 'error' })
    return Object.freeze({
      targetProfileRef: target,
      targetChanged: false,
      ledgerChanged: false,
      appliedBindingIds: Object.freeze([]),
      diagnostics: Object.freeze([diagnostic]),
      projection: Object.freeze({
        ...projectCodexProviderProfile({ target, ledger, diagnostics: [diagnostic] }),
        persisted: Object.freeze({ status: 'invalid' as const }),
      }),
    })
  }
  if (codexTargetHasUnsupportedInlineProviders(snapshot.raw)) {
    const diagnostic: ProviderSyncDiagnostic = Object.freeze({
      code: 'unsupported-config-shape',
      severity: 'error',
    })
    return Object.freeze({
      targetProfileRef: target,
      targetChanged: false,
      ledgerChanged: false,
      appliedBindingIds: Object.freeze([]),
      diagnostics: Object.freeze([diagnostic]),
      projection: projectCodexProviderProfile({ target, snapshot, ledger, diagnostics: [diagnostic] }),
    })
  }
  const connections = new Map(options.connections.map(value => {
    const connection = parseProviderSyncConnection(value)
    return [connection.connectionId, connection] as const
  }))
  const activeLedger = new Map(
    ledger.bindings.flatMap(entry =>
      targetProfileRefKey(entry.targetProfileRef) === targetProfileRefKey(target) && entry.state !== 'tombstoned'
        ? [[entry.bindingId, entry] as const]
        : []
    ),
  )
  const bindings = options.bindings.map(parseProviderSyncBinding).filter(binding =>
    targetProfileRefKey(binding.targetProfileRef) === targetProfileRefKey(target)
  )
  if (new Set(bindings.map(binding => binding.bindingId)).size !== bindings.length) {
    throw new Error('provider sync bindings are duplicated')
  }
  const plans = bindings.map(binding => {
    const connection = connections.get(binding.connectionId)
    if (connection === undefined) throw new Error('provider sync binding references a missing connection')
    const ledgerEntry = activeLedger.get(binding.bindingId)
    return createBindingPlan({
      binding,
      connection,
      ...(ledgerEntry === undefined ? {} : { ledger: ledgerEntry }),
      snapshot,
    })
  })
  const diagnostics = Object.freeze(plans.flatMap(plan => plan.diagnostics))
  const nextRaw = applyCodexProviderTargetPlans(
    snapshot,
    plans.map(plan => ({
      localProviderId: plan.binding.localProviderId,
      desired: plan.desired,
      apply: plan.apply,
    })),
  )
  const nextLedger = updatedLedger(ledger, plans)
  const targetChanged = nextRaw !== snapshot.raw
  const ledgerChanged = !equal(nextLedger, ledger)
  if (!targetChanged) {
    if (ledgerChanged && await store.commit(nextLedger) !== 'applied') {
      const diagnostic: ProviderSyncDiagnostic = Object.freeze({ code: 'concurrent-edit', severity: 'warning' })
      return Object.freeze({
        targetProfileRef: target,
        targetChanged: false,
        ledgerChanged: false,
        appliedBindingIds: Object.freeze([]),
        diagnostics: Object.freeze([...diagnostics, diagnostic]),
        projection: projectCodexProviderProfile({
          target,
          snapshot,
          ledger,
          diagnostics: [...diagnostics, diagnostic],
        }),
      })
    }
    const projectedLedger = ledgerChanged ? nextLedger : ledger
    return Object.freeze({
      targetProfileRef: target,
      targetChanged: false,
      ledgerChanged,
      appliedBindingIds: Object.freeze(
        plans.filter(plan => plan.skipped.length === 0).map(plan => plan.binding.bindingId),
      ),
      diagnostics,
      projection: projectCodexProviderProfile({ target, snapshot, ledger: projectedLedger, diagnostics }),
    })
  }
  parse(nextRaw)
  const targetPath = path.join(target.configRoot, 'config.toml')
  const stagedPath = await stageTarget(targetPath, nextRaw)
  const afterRevision = providerSyncRevision(nextRaw)
  const journal = Object.freeze({
    version: 1 as const,
    transactionId: randomUUID(),
    targetProfileRef: target,
    targetPath,
    phase: 'prepared' as const,
    beforeRevision: snapshot.revision,
    afterRevision,
    stagedPath,
    ledger: nextLedger,
  })
  await store.writeJournal(journal)
  try {
    await options.beforeCommit?.()
    const current = await readFile(targetPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    if (providerSyncRevision(current) !== snapshot.revision) {
      await store.removeJournal()
      await rm(stagedPath, { force: true })
      const diagnostic: ProviderSyncDiagnostic = Object.freeze({ code: 'concurrent-edit', severity: 'warning' })
      return Object.freeze({
        targetProfileRef: target,
        targetChanged: false,
        ledgerChanged: false,
        appliedBindingIds: Object.freeze([]),
        diagnostics: Object.freeze([...diagnostics, diagnostic]),
        projection: projectCodexProviderProfile({
          target,
          snapshot: await readCodexProviderTarget(target) ?? snapshot,
          ledger,
          diagnostics: [...diagnostics, diagnostic],
        }),
      })
    }
    await store.writeJournal(Object.freeze({ ...journal, phase: 'committing' as const }))
    await rename(stagedPath, targetPath)
    if (process.platform !== 'win32') await chmod(targetPath, 0o600)
    await options.afterTargetCommit?.()
    if (await store.commit(nextLedger) !== 'applied') throw new Error('provider sync ledger changed during commit')
    await store.removeJournal()
  } catch (error) {
    const committed = providerSyncRevision(await readFile(targetPath, 'utf8').catch(() => '')) === afterRevision
    if (!committed) {
      await store.removeJournal().catch(() => undefined)
      await rm(stagedPath, { force: true }).catch(() => undefined)
    }
    throw error
  }
  const committedSnapshot = await readCodexProviderTarget(target)
  if (committedSnapshot === undefined || committedSnapshot.revision !== afterRevision) {
    throw new Error('provider sync target readback failed')
  }
  return Object.freeze({
    targetProfileRef: target,
    targetChanged: true,
    ledgerChanged,
    appliedBindingIds: Object.freeze(plans.filter(plan => plan.apply.length > 0).map(plan => plan.binding.bindingId)),
    diagnostics,
    projection: projectCodexProviderProfile({ target, snapshot: committedSnapshot, ledger: nextLedger, diagnostics }),
  })
}
