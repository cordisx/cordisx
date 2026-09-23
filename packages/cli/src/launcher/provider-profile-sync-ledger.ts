import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  assertProviderSyncId,
  parseProviderSyncBinding,
  parseProviderSyncConnection,
  parseProviderSyncTargetProfileRef,
  type ProviderSyncBindingDefinition,
  type ProviderSyncConnectionDefinition,
  type ProviderSyncNativeConnection,
  type ProviderSyncTargetProfileRef,
  targetProfileRefKey,
} from './provider-profile-sync-contracts.js'

export interface ProviderSyncFieldGroups {
  readonly display?: Readonly<Record<string, string | boolean>>
  readonly routing?: Readonly<Record<string, string | boolean>>
}

export interface ProviderSyncBindingLedgerEntry {
  readonly bindingId: string
  readonly connectionId: string
  readonly targetProfileRef: ProviderSyncTargetProfileRef
  readonly localProviderId: string
  readonly ownership: 'created' | 'adopted'
  readonly state: 'managed' | 'detached' | 'tombstoned'
  readonly credentialDelivery: 'process-env'
  readonly sourceRevision: string
  readonly credentialRevision: string
  readonly overlay?: ProviderSyncBindingDefinition['overlay']
  readonly models: ProviderSyncConnectionDefinition['models']
  readonly lastApplied: ProviderSyncFieldGroups
  readonly observedTarget?: ProviderSyncFieldGroups
  readonly warningFingerprints: readonly string[]
  readonly importedFrom?: string
}

export interface ProviderSyncImportLedgerEntry {
  readonly sourceRef: string
  readonly connectionId: string
}

export interface ProviderSyncLedger {
  readonly version: 1
  readonly generation: number
  readonly bindings: readonly ProviderSyncBindingLedgerEntry[]
  readonly imports: readonly ProviderSyncImportLedgerEntry[]
}

export interface ProviderSyncJournal {
  readonly version: 1
  readonly transactionId: string
  readonly targetProfileRef: ProviderSyncTargetProfileRef
  readonly targetPath: string
  readonly phase: 'prepared' | 'committing'
  readonly beforeRevision: string
  readonly afterRevision: string
  readonly stagedPath: string
  readonly ledger: ProviderSyncLedger
}

const EMPTY_LEDGER: ProviderSyncLedger = Object.freeze({
  version: 1,
  generation: 0,
  bindings: Object.freeze([]),
  imports: Object.freeze([]),
})

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export function providerSyncRevision(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function createProviderSyncId(kind: 'connection' | 'binding'): string {
  return `cx-${kind}-${randomBytes(18).toString('base64url')}`
}

function stringMap(value: unknown): Readonly<Record<string, string | boolean>> | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  const result: Record<string, string | boolean> = Object.create(null)
  for (const [key, item] of Object.entries(source)) {
    if (typeof item !== 'string' && typeof item !== 'boolean') throw new Error('provider sync ledger is invalid')
    result[key] = item
  }
  return Object.freeze(result)
}

function groups(value: unknown): ProviderSyncFieldGroups {
  const source = record(value) ?? {}
  if (Object.keys(source).some(key => key !== 'display' && key !== 'routing')) {
    throw new Error('provider sync ledger is invalid')
  }
  const display = stringMap(source.display)
  const routing = stringMap(source.routing)
  return Object.freeze({
    ...(display === undefined ? {} : { display }),
    ...(routing === undefined ? {} : { routing }),
  })
}

function parseBindingEntry(value: unknown): ProviderSyncBindingLedgerEntry {
  const source = record(value)
  if (source === undefined) throw new Error('provider sync ledger is invalid')
  const binding = parseProviderSyncBinding({
    bindingId: source.bindingId as string,
    connectionId: source.connectionId as string,
    targetProfileRef: source.targetProfileRef as ProviderSyncTargetProfileRef,
    localProviderId: source.localProviderId as string,
    enabled: source.state === 'managed',
    credentialDelivery: source.credentialDelivery as 'process-env',
    ...(source.overlay === undefined
      ? {}
      : { overlay: source.overlay as NonNullable<ProviderSyncBindingDefinition['overlay']> }),
  })
  if (!['created', 'adopted'].includes(String(source.ownership))) throw new Error('provider sync ledger is invalid')
  if (!['managed', 'detached', 'tombstoned'].includes(String(source.state))) {
    throw new Error('provider sync ledger is invalid')
  }
  if (typeof source.sourceRevision !== 'string' || typeof source.credentialRevision !== 'string') {
    throw new Error('provider sync ledger is invalid')
  }
  const models = record(source.models)
  if (
    models === undefined || !Array.isArray(models.ids)
    || !models.ids.every(id => typeof id === 'string')
    || !['unknown', 'partial', 'complete'].includes(String(models.completeness))
  ) throw new Error('provider sync ledger is invalid')
  const warningFingerprints = source.warningFingerprints
  if (!Array.isArray(warningFingerprints) || !warningFingerprints.every(item => typeof item === 'string')) {
    throw new Error('provider sync ledger is invalid')
  }
  if (source.importedFrom !== undefined && typeof source.importedFrom !== 'string') {
    throw new Error('provider sync ledger is invalid')
  }
  return Object.freeze({
    bindingId: binding.bindingId,
    connectionId: binding.connectionId,
    targetProfileRef: binding.targetProfileRef,
    localProviderId: binding.localProviderId,
    ownership: source.ownership as 'created' | 'adopted',
    state: source.state as ProviderSyncBindingLedgerEntry['state'],
    credentialDelivery: binding.credentialDelivery,
    sourceRevision: source.sourceRevision,
    credentialRevision: source.credentialRevision,
    ...(binding.overlay === undefined ? {} : { overlay: binding.overlay }),
    models: Object.freeze({
      ids: Object.freeze([...models.ids] as string[]),
      completeness: models.completeness as ProviderSyncConnectionDefinition['models']['completeness'],
    }),
    lastApplied: groups(source.lastApplied),
    ...(source.observedTarget === undefined ? {} : { observedTarget: groups(source.observedTarget) }),
    warningFingerprints: Object.freeze([...warningFingerprints]),
    ...(source.importedFrom === undefined ? {} : { importedFrom: source.importedFrom }),
  })
}

export function parseProviderSyncLedger(value: unknown): ProviderSyncLedger {
  if (value === undefined) return EMPTY_LEDGER
  const source = record(value)
  if (
    source?.version !== 1 || !Number.isSafeInteger(source.generation) || Number(source.generation) < 0
    || !Array.isArray(source.bindings) || !Array.isArray(source.imports)
  ) throw new Error('provider sync ledger is invalid')
  const bindings = source.bindings.map(parseBindingEntry)
  const bindingIds = new Set<string>()
  const ownership = new Set<string>()
  for (const binding of bindings) {
    if (bindingIds.has(binding.bindingId)) throw new Error('provider sync ledger has duplicate bindings')
    bindingIds.add(binding.bindingId)
    const key = JSON.stringify([targetProfileRefKey(binding.targetProfileRef), binding.localProviderId])
    if (binding.state === 'managed' && ownership.has(key)) {
      throw new Error('provider sync ledger has duplicate ownership')
    }
    if (binding.state === 'managed') ownership.add(key)
  }
  const imports = source.imports.map(value => {
    const item = record(value)
    if (typeof item?.sourceRef !== 'string') throw new Error('provider sync ledger is invalid')
    assertProviderSyncId(item.connectionId, 'connection')
    return Object.freeze({ sourceRef: item.sourceRef, connectionId: item.connectionId })
  })
  if (new Set(imports.map(item => item.sourceRef)).size !== imports.length) {
    throw new Error('provider sync ledger has duplicate imports')
  }
  return Object.freeze({
    version: 1,
    generation: Number(source.generation),
    bindings: Object.freeze(bindings),
    imports: Object.freeze(imports),
  })
}

async function readPrivateJson(file: string): Promise<{ raw?: string; value?: unknown }> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) throw new Error('provider sync state is invalid')
      const raw = await handle.readFile('utf8')
      return { raw, value: JSON.parse(raw) }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function privateAtomicWrite(file: string, raw: string): Promise<void> {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
  const temporary = path.join(directory, `.provider-sync-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(raw)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    if (process.platform !== 'win32') await chmod(file, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

export class ProviderProfileSyncLedgerStore {
  readonly ledgerPath: string
  readonly journalPath: string
  #raw: string | undefined
  #loaded = false

  constructor(readonly stateDir: string) {
    this.ledgerPath = path.join(stateDir, 'provider-profile-bindings.json')
    this.journalPath = path.join(stateDir, 'provider-profile-transaction.json')
  }

  async read(): Promise<ProviderSyncLedger> {
    const state = await readPrivateJson(this.ledgerPath)
    this.#raw = state.raw
    this.#loaded = true
    return parseProviderSyncLedger(state.value)
  }

  async commit(ledger: ProviderSyncLedger): Promise<'applied' | 'conflict'> {
    if (!this.#loaded) await this.read()
    const current = await readPrivateJson(this.ledgerPath)
    if (current.raw !== this.#raw) return 'conflict'
    const raw = `${JSON.stringify(parseProviderSyncLedger(ledger), null, 2)}\n`
    if (raw === this.#raw) return 'applied'
    await privateAtomicWrite(this.ledgerPath, raw)
    this.#raw = raw
    return 'applied'
  }

  async readJournal(): Promise<ProviderSyncJournal | undefined> {
    const state = await readPrivateJson(this.journalPath)
    if (state.value === undefined) return undefined
    const source = record(state.value)
    if (
      source?.version !== 1 || typeof source.transactionId !== 'string'
      || typeof source.targetPath !== 'string' || !['prepared', 'committing'].includes(String(source.phase))
      || typeof source.beforeRevision !== 'string' || typeof source.afterRevision !== 'string'
      || typeof source.stagedPath !== 'string'
    ) throw new Error('provider sync journal is invalid')
    return Object.freeze({
      version: 1,
      transactionId: source.transactionId,
      targetProfileRef: parseProviderSyncTargetProfileRef(source.targetProfileRef as ProviderSyncTargetProfileRef),
      targetPath: source.targetPath,
      phase: source.phase as ProviderSyncJournal['phase'],
      beforeRevision: source.beforeRevision,
      afterRevision: source.afterRevision,
      stagedPath: source.stagedPath,
      ledger: parseProviderSyncLedger(source.ledger),
    })
  }

  async writeJournal(journal: ProviderSyncJournal): Promise<void> {
    await privateAtomicWrite(this.journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  }

  async removeJournal(): Promise<void> {
    await rm(this.journalPath, { force: true })
  }
}

export function bindProviderConnection(
  ledger: ProviderSyncLedger,
  connection: ProviderSyncConnectionDefinition,
  binding: Omit<ProviderSyncBindingDefinition, 'bindingId'> & { readonly bindingId?: string },
): { readonly ledger: ProviderSyncLedger; readonly binding: ProviderSyncBindingDefinition } {
  const source = parseProviderSyncConnection(connection)
  const target = parseProviderSyncTargetProfileRef(binding.targetProfileRef)
  const existing = ledger.bindings.find(item =>
    item.connectionId === source.connectionId
    && targetProfileRefKey(item.targetProfileRef) === targetProfileRefKey(target)
    && item.state !== 'tombstoned'
  )
  const definition = parseProviderSyncBinding({
    ...binding,
    bindingId: existing?.bindingId ?? binding.bindingId ?? createProviderSyncId('binding'),
    connectionId: source.connectionId,
    targetProfileRef: target,
  })
  if (existing !== undefined) return { ledger, binding: definition }
  return {
    binding: definition,
    ledger: Object.freeze({
      ...ledger,
      generation: ledger.generation + 1,
      bindings: Object.freeze([
        ...ledger.bindings,
        Object.freeze({
          bindingId: definition.bindingId,
          connectionId: definition.connectionId,
          targetProfileRef: definition.targetProfileRef,
          localProviderId: definition.localProviderId,
          ownership: 'created' as const,
          state: 'managed' as const,
          credentialDelivery: definition.credentialDelivery,
          sourceRevision: source.revision,
          credentialRevision: source.credential.revision,
          ...(definition.overlay === undefined ? {} : { overlay: definition.overlay }),
          models: source.models,
          lastApplied: Object.freeze({}),
          warningFingerprints: Object.freeze([]),
        }),
      ]),
    }),
  }
}

export function importNativeProviderConnection(input: {
  readonly ledger: ProviderSyncLedger
  readonly native: ProviderSyncNativeConnection
  readonly credential: ProviderSyncConnectionDefinition['credential']
  readonly copy?: boolean
}): { readonly ledger: ProviderSyncLedger; readonly connection: ProviderSyncConnectionDefinition } {
  const target = parseProviderSyncTargetProfileRef(input.native.targetProfileRef)
  const sourceRef = JSON.stringify(['native', targetProfileRefKey(target), input.native.nativeLocalId])
  const existing = input.copy === true ? undefined : input.ledger.imports.find(item => item.sourceRef === sourceRef)
  const connectionId = existing?.connectionId ?? createProviderSyncId('connection')
  const connection = parseProviderSyncConnection({
    connectionId,
    revision: `import:${providerSyncRevision(sourceRef)}`,
    title: input.native.title,
    endpoint: input.native.endpoint ?? 'https://unconfigured.invalid/',
    protocol: input.native.protocol ?? 'responses',
    credential: input.credential,
    models: {
      ids: input.native.activeModelId === undefined ? [] : [input.native.activeModelId],
      completeness: input.native.activeModelId === undefined ? 'unknown' : 'partial',
    },
    enabled: true,
  })
  if (existing !== undefined) return { ledger: input.ledger, connection }
  return {
    connection,
    ledger: Object.freeze({
      ...input.ledger,
      generation: input.ledger.generation + 1,
      imports: Object.freeze([...input.ledger.imports, Object.freeze({ sourceRef, connectionId })]),
    }),
  }
}

export function setProviderBindingState(
  ledger: ProviderSyncLedger,
  bindingId: string,
  state: ProviderSyncBindingLedgerEntry['state'],
): ProviderSyncLedger {
  assertProviderSyncId(bindingId, 'binding')
  let found = false
  const bindings = ledger.bindings.map(binding => {
    if (binding.bindingId !== bindingId) return binding
    found = true
    return Object.freeze({ ...binding, state })
  })
  if (!found) throw new Error('provider sync binding was not found')
  return Object.freeze({ ...ledger, generation: ledger.generation + 1, bindings: Object.freeze(bindings) })
}

export function adoptProviderBinding(input: {
  readonly ledger: ProviderSyncLedger
  readonly connection: ProviderSyncConnectionDefinition
  readonly binding: ProviderSyncBindingDefinition
  readonly targetGroups: ProviderSyncFieldGroups
  readonly importedFrom?: string
}): ProviderSyncLedger {
  const connection = parseProviderSyncConnection(input.connection)
  const binding = parseProviderSyncBinding(input.binding)
  if (binding.connectionId !== connection.connectionId) throw new Error('provider sync binding connection mismatch')
  if (input.ledger.bindings.some(item => item.bindingId === binding.bindingId)) return input.ledger
  if (
    input.ledger.bindings.some(item =>
      item.state === 'managed' && item.localProviderId === binding.localProviderId
      && targetProfileRefKey(item.targetProfileRef) === targetProfileRefKey(binding.targetProfileRef)
    )
  ) throw new Error('provider sync target provider is already owned')
  return Object.freeze({
    ...input.ledger,
    generation: input.ledger.generation + 1,
    bindings: Object.freeze([
      ...input.ledger.bindings,
      Object.freeze({
        bindingId: binding.bindingId,
        connectionId: binding.connectionId,
        targetProfileRef: binding.targetProfileRef,
        localProviderId: binding.localProviderId,
        ownership: 'adopted' as const,
        state: 'managed' as const,
        credentialDelivery: binding.credentialDelivery,
        sourceRevision: connection.revision,
        credentialRevision: connection.credential.revision,
        ...(binding.overlay === undefined ? {} : { overlay: binding.overlay }),
        models: connection.models,
        lastApplied: groups(input.targetGroups),
        warningFingerprints: Object.freeze([]),
        ...(input.importedFrom === undefined ? {} : { importedFrom: input.importedFrom }),
      }),
    ]),
  })
}
