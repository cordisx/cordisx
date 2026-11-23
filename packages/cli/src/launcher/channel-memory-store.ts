import { validateMemoryRecord } from './channel-memory-record-validation.js'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { MemoryFiles } from './channel-memory-files.js'
import type { UserMemoryAssertion } from './channel-user-memory-model.js'
import { userMemoryMatches } from './channel-user-memory-request.js'
import {
  type MemoryAccount,
  type MemoryAuthority,
  type MemoryGrant,
  memoryKey,
  memoryReadable,
} from './channel-memory-policy.js'

export interface MemoryInput {
  kind: 'fact' | 'preference' | 'person' | 'conversation' | 'collaboration' | 'impression'
  title: string
  summary: string
  tags: string[]
  entityRefs: string[]
  evidenceType: string
  confidence: number
  expiresAt?: string
  observedAt?: string
}
export interface MemoryRecord extends MemoryInput {
  schemaVersion: 1
  id: string
  revision: number
  scopeId: string
  owner: string
  createdAt: string
  updatedAt: string
  provenance: { messageId: string; actor: string; conversation: string }
  /** Host-extracted explicit self-information, separate from management authority. */
  userMemory?: { key: string; category: UserMemoryAssertion['category']; sequence: number }
}
interface MemoryState {
  schemaVersion: 1
  revision: number
  records: Record<string, number>
  grants: MemoryGrant[]
  bindings: Record<string, string>
  catalog: Record<string, Omit<MemoryRecord, 'summary'> & { keywords: string }>
  userSequences?: Record<string, number>
  challenges?: Record<
    string,
    { initiator: MemoryAccount; target: MemoryAccount; expiresAt: string; consumedAt?: string }
  >
}
const date = (value: string): boolean => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const id = (value: string): void => {
  if (!/^[a-f0-9-]{36}$/u.test(value)) throw new Error('MEMORY_INVALID_ID')
}
const validate = (input: MemoryInput) => {
  try {
    validateMemoryRecord(input, false)
  } catch {
    throw new Error('MEMORY_INVALID_RECORD')
  }
}
const validateInput = (input: MemoryInput) => validateMemoryRecord(input)
export class ChannelMemoryStore {
  readonly files: MemoryFiles
  constructor(root: string, private readonly clock: () => string = () => new Date().toISOString()) {
    this.files = new MemoryFiles(root)
  }
  private async state(): Promise<MemoryState> {
    try {
      const state = await this.files.read('state.json') as MemoryState
      if (
        state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || !state.records
        || !Array.isArray(state.grants) || !state.bindings || !state.catalog
      ) throw new Error('MEMORY_INVALID_STATE')
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, revision: 0, records: {}, grants: [], bindings: {}, catalog: {} }
    }
  }
  private async save(state: MemoryState): Promise<void> {
    state.revision += 1
    await this.files.write('state.json', state)
  }
  private catalog(record: MemoryRecord): MemoryState['catalog'][string] {
    const { summary, ...metadata } = record
    return { ...metadata, keywords: [record.title, summary, ...record.tags].join(' ').toLocaleLowerCase() }
  }
  async browse(authority: MemoryAuthority, options: {
    query?: string
    entity?: string
    cursor?: string
    limit?: number
    maxBytes?: number
    navigation?: boolean
    userOnly?: boolean
  }): Promise<unknown> {
    const limit = options.limit ?? 8, maxBytes = options.maxBytes ?? 4096
    if (
      !Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(maxBytes)
      || maxBytes < 512 || maxBytes > 16384 || options.query && options.query.length > 256
    ) {
      throw new Error('MEMORY_INVALID_QUERY')
    }
    await this.files.prepare()
    const state = await this.state()
    let offset = 0
    if (options.cursor) {
      const match = /^([0-9]+):([0-9]+)$/u.exec(options.cursor)
      if (!match || Number(match[1]) !== state.revision) throw new Error('MEMORY_CURSOR_STALE')
      offset = Number(match[2])
    }
    const words = (options.query ?? '').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean).slice(0, 16)
    const entries = Object.values(state.catalog).filter(record =>
      memoryReadable(record, authority, state.grants, state.bindings, this.clock())
      && (!options.userOnly
        || record.owner === memoryKey(authority.actor) && !!authority.userRecall
          && userMemoryMatches(record, authority.userRecall))
      && (!options.entity || record.entityRefs.includes(options.entity) || record.tags.includes(options.entity))
      && words.every(word => record.keywords.includes(word))
    )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    const sources = new Map<string, typeof entries>()
    for (const record of entries) {
      const source = record.provenance.conversation
      sources.set(source, [...(sources.get(source) ?? []), record])
    }
    const ordered: typeof entries = []
    while ([...sources.values()].some(rows => rows.length)) {
      for (const rows of sources.values()) {
        const record = rows.shift()
        if (record) ordered.push(record)
      }
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > ordered.length) throw new Error('MEMORY_INVALID_QUERY')
    const cards = []
    let position = offset
    for (const record of ordered.slice(offset, offset + limit)) {
      const card = {
        id: record.id,
        revision: record.revision,
        title: record.title,
        summary: options.navigation ? undefined : record.keywords.slice(0, 160),
        entities: record.entityRefs.slice(0, 8),
        projects: record.tags.slice(0, 8),
        time: record.updatedAt,
        status: 'active',
        source: record.provenance,
      }
      if (Buffer.byteLength(JSON.stringify({ cards: [...cards, card] })) + 160 > maxBytes) break
      cards.push(card)
      position += 1
    }
    return {
      revision: state.revision,
      cards,
      nextCursor: position < ordered.length ? `${state.revision}:${position}` : null,
      returnedBytes: Buffer.byteLength(JSON.stringify(cards)),
      truncated: position < ordered.length,
    }
  }
  async batch(authority: MemoryAuthority, ids: string[], maxBytes = 8192): Promise<MemoryRecord[]> {
    if (
      !Array.isArray(ids) || ids.length > 8 || !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 32768
    ) {
      throw new Error('MEMORY_INVALID_REQUEST')
    }
    const result: MemoryRecord[] = []
    for (const recordId of ids) {
      const record = await this.get(authority, recordId)
      if (Buffer.byteLength(JSON.stringify([...result, record])) > maxBytes) throw new Error('MEMORY_BUDGET_EXCEEDED')
      result.push(record)
    }
    return result
  }
  private async record(recordId: string, state: MemoryState): Promise<MemoryRecord> {
    id(recordId)
    if (state.records[recordId] === undefined) throw new Error('MEMORY_NOT_FOUND')
    const record = await this.files.read(`${recordId}-${state.records[recordId]}.json`) as MemoryRecord
    validate(record)
    if (record.schemaVersion !== 1 || record.id !== recordId || record.revision !== state.records[recordId]) {
      throw new Error('MEMORY_INVALID_RECORD')
    }
    if (
      record.userMemory && (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(record.userMemory.key)
        || !['name', 'relationship', 'preference', 'fact'].includes(record.userMemory.category)
        || !Number.isSafeInteger(record.userMemory.sequence) || record.userMemory.sequence < 1)
    ) throw new Error('MEMORY_INVALID_RECORD')
    return record
  }
  async remember(authority: MemoryAuthority, input: MemoryInput, messageId: string): Promise<MemoryRecord> {
    validateInput(input)
    if (!messageId || messageId.length > 512) throw new Error('MEMORY_INVALID_PROVENANCE')
    return this.files.locked(async () => {
      const state = await this.state(), now = this.clock()
      const owner = memoryKey(authority.actor), scopeId = memoryKey(authority.conversation)
      const record: MemoryRecord = {
        ...input,
        schemaVersion: 1,
        id: randomUUID(),
        revision: 1,
        owner,
        scopeId,
        createdAt: now,
        updatedAt: now,
        provenance: { actor: owner, conversation: scopeId, messageId },
      }
      await this.files.write(`${record.id}-1.json`, record)
      state.records[record.id] = record.revision
      state.catalog[record.id] = this.catalog(record)
      await this.save(state)
      return record
    })
  }
  async get(authority: MemoryAuthority, recordId: string): Promise<MemoryRecord> {
    await this.files.prepare()
    id(recordId)
    const state = await this.state(), metadata = state.catalog[recordId]
    if (!metadata || !memoryReadable(metadata, authority, state.grants, state.bindings, this.clock())) {
      throw new Error('MEMORY_NOT_FOUND')
    }
    const record = await this.record(recordId, state)
    return record
  }
  async rememberUser(
    authority: MemoryAuthority,
    assertions: readonly UserMemoryAssertion[],
    source: { messageId: string; sequence: number },
    current: () => boolean,
  ): Promise<MemoryRecord[]> {
    if (
      !source.messageId || source.messageId.length > 512 || !Number.isSafeInteger(source.sequence)
      || source.sequence < 1
    ) throw new Error('MEMORY_INVALID_PROVENANCE')
    return this.files.locked(async () => {
      const state = await this.state(),
        now = this.clock(),
        owner = memoryKey(authority.actor),
        scopeId = memoryKey(authority.conversation)
      const records: MemoryRecord[] = []
      let changed = false
      for (const assertion of assertions) {
        if (!current()) return []
        const sequenceKey = createHash('sha256').update(JSON.stringify([owner, assertion.key])).digest('hex')
        const watermark = state.userSequences?.[sequenceKey] ?? 0
        if (watermark > source.sequence) continue
        const candidates = Object.values(state.catalog).filter(row =>
          row.owner === owner && row.userMemory?.key === assertion.key
        )
        if (candidates.length > 1) throw new Error('MEMORY_USER_RECORD_CONFLICT')
        const prior = candidates[0] ? await this.record(candidates[0].id, state) : undefined
        // A forgotten assertion leaves its sequence fence, so queued older introductions cannot restore it.
        if (!prior && watermark >= source.sequence) continue
        if (prior && prior.userMemory!.sequence > source.sequence) continue
        if (prior && prior.userMemory!.sequence === source.sequence) {
          if (prior.provenance.messageId === source.messageId) records.push(prior)
          continue
        }
        const input: MemoryInput = {
          kind: assertion.category === 'preference' ? 'preference' : assertion.category === 'fact' ? 'fact' : 'person',
          title: assertion.title,
          summary: assertion.evidence,
          tags: [assertion.key],
          entityRefs: [],
          evidenceType: 'user-declared',
          confidence: 1,
        }
        validateInput(input)
        const record: MemoryRecord = {
          ...input,
          schemaVersion: 1,
          id: prior?.id ?? randomUUID(),
          revision: (prior?.revision ?? 0) + 1,
          owner,
          scopeId,
          createdAt: prior?.createdAt ?? now,
          updatedAt: now,
          provenance: { actor: owner, conversation: scopeId, messageId: source.messageId },
          userMemory: { key: assertion.key, category: assertion.category, sequence: source.sequence },
        }
        await this.files.write(`${record.id}-${record.revision}.json`, record)
        state.records[record.id] = record.revision
        state.catalog[record.id] = this.catalog(record)
        state.userSequences ??= {}
        state.userSequences[sequenceKey] = source.sequence
        changed = true
        records.push(record)
      }
      if (!current()) return []
      if (changed) await this.save(state)
      return current() ? records : []
    })
  }
  async change(
    authority: MemoryAuthority,
    recordId: string,
    revision: number,
    input?: MemoryInput,
  ): Promise<MemoryRecord | null> {
    if (input) validateInput(input)
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('MEMORY_INVALID_REVISION')
    return this.files.locked(async () => {
      const state = await this.state()
      id(recordId)
      const metadata = state.catalog[recordId]
      if (!metadata || metadata.owner !== memoryKey(authority.actor)) throw new Error('MEMORY_NOT_FOUND')
      const record = await this.record(recordId, state)
      if (record.revision !== revision) throw new Error('MEMORY_REVISION_CONFLICT')
      if (!input) {
        delete state.records[recordId]
        delete state.catalog[recordId]
        await this.save(state)
        const { unlink } = await import('node:fs/promises')
        const { readdir } = await import('node:fs/promises')
        for (const name of await readdir(this.files.root)) {
          if (name.startsWith(`${recordId}-`)) await unlink(this.files.file(name))
        }
        return null
      }
      const updated: MemoryRecord = {
        ...input,
        ...(record.userMemory ? { userMemory: record.userMemory } : {}),
        schemaVersion: 1,
        id: record.id,
        scopeId: record.scopeId,
        owner: record.owner,
        createdAt: record.createdAt,
        provenance: record.provenance,
        revision: revision + 1,
        updatedAt: this.clock(),
      }
      await this.files.write(`${recordId}-${updated.revision}.json`, updated)
      state.records[recordId] = updated.revision
      state.catalog[recordId] = this.catalog(updated)
      await this.save(state)
      return memoryReadable(updated, authority, state.grants, state.bindings, this.clock()) ? updated : null
    })
  }
  async index(authority: MemoryAuthority): Promise<{ revision: number; count: number }> {
    return this.files.locked(async () => {
      const state = await this.state(), scope = memoryKey(authority.conversation)
      const entries = []
      const candidates = Object.keys(state.records).filter(recordId =>
        state.catalog[recordId]?.owner === memoryKey(authority.actor)
        && state.catalog[recordId]?.scopeId === scope
      )
      if (candidates.length > 2000) throw new Error('MEMORY_CAPACITY_EXCEEDED')
      for (const recordId of candidates) {
        const record = await this.record(recordId, state)
        if (record.owner === memoryKey(authority.actor) && record.scopeId === scope) {
          state.catalog[recordId] = this.catalog(record)
          entries.push({
            id: record.id,
            title: record.title,
            tags: record.tags,
            entityRefs: record.entityRefs,
          })
        }
      }
      await this.files.write('index.json', { schemaVersion: 1, revision: state.revision, entries })
      await this.save(state)
      return { revision: state.revision, count: entries.length }
    })
  }
  async search(authority: MemoryAuthority, query: string, entity?: string): Promise<unknown[]> {
    if (typeof query !== 'string' || query.length > 256 || !query.trim()) {
      throw new Error('MEMORY_INVALID_QUERY')
    }
    await this.files.prepare()
    const state = await this.state(),
      result = [],
      words = query.toLocaleLowerCase().split(/\s+/u).slice(0, 16)
    let bytes = 0
    for (const recordId of Object.keys(state.records).slice(0, 2000)) {
      const record = state.catalog[recordId]
      if (!record || record.revision !== state.records[recordId]) {
        throw new Error('MEMORY_INDEX_RECOVERY_REQUIRED')
      }
      if (!memoryReadable(record, authority, state.grants, state.bindings, this.clock())) continue
      const haystack = record.keywords
      if (!words.every(word => haystack.includes(word)) || entity && !record.entityRefs.includes(entity)) {
        continue
      }
      const row = {
        id: record.id,
        revision: record.revision,
        title: record.title,
        tags: record.tags,
        entityRefs: record.entityRefs,
        updatedAt: record.updatedAt,
        provenance: record.provenance,
      }
      bytes += Buffer.byteLength(JSON.stringify(row))
      if (bytes > 16384 || result.length >= 20) break
      result.push(row)
    }
    return result
  }
  async grant(
    authority: MemoryAuthority,
    input: Pick<MemoryGrant, 'source' | 'target' | 'expiresAt' | 'recordIds'>,
  ): Promise<MemoryGrant> {
    if (!authority.administer?.includes(input.source)) throw new Error('MEMORY_GRANT_AUTHORITY_UNAVAILABLE')
    if (
      !/^[a-f0-9]{64}$/u.test(input.source)
      || !['conversation', 'account', 'entity'].includes(input.target?.kind)
      || !/^[a-f0-9]{64}$/u.test(input.target.id) || input.expiresAt && !date(input.expiresAt)
      || input.recordIds
        && (input.recordIds.length > 256 || input.recordIds.some(value => !/^[a-f0-9-]{36}$/u.test(value)))
    ) {
      throw new Error('MEMORY_INVALID_GRANT')
    }
    return this.files.locked(async () => {
      const state = await this.state()
      const grant = {
        ...input,
        id: randomUUID(),
        createdBy: memoryKey(authority.actor),
        createdAt: this.clock(),
      }
      state.grants.push(grant)
      await this.save(state)
      return grant
    })
  }
  async grants(authority: MemoryAuthority): Promise<MemoryGrant[]> {
    await this.files.prepare()
    return (await this.state()).grants.filter(grant => authority.administer?.includes(grant.source))
  }
  async revoke(authority: MemoryAuthority, grantId: string): Promise<void> {
    id(grantId)
    await this.files.locked(async () => {
      const state = await this.state(), grant = state.grants.find(value => value.id === grantId)
      if (!grant || !authority.administer?.includes(grant.source)) throw new Error('MEMORY_NOT_FOUND')
      grant.revokedAt = this.clock()
      await this.save(state)
    })
  }
  async bindConfirmed(entity: string, accounts: readonly MemoryAccount[]): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(entity) || accounts.length < 2 || accounts.length > 16) {
      throw new Error('MEMORY_INVALID_BINDING')
    }
    const keys = accounts.map(memoryKey)
    if (new Set(keys).size !== keys.length) throw new Error('MEMORY_BINDING_COLLISION')
    await this.files.locked(async () => {
      const state = await this.state()
      if (keys.some(key => state.bindings[key] && state.bindings[key] !== entity)) {
        throw new Error('MEMORY_BINDING_COLLISION')
      }
      for (const key of keys) state.bindings[key] = entity
      await this.save(state)
    })
  }
  async challenge(
    authority: MemoryAuthority,
    target: MemoryAccount,
  ): Promise<{ challenge: string; expiresAt: string }> {
    if (memoryKey(target) === memoryKey(authority.actor)) throw new Error('MEMORY_BINDING_COLLISION')
    return this.files.locked(async () => {
      const state = await this.state(), challenge = randomUUID()
      const expiresAt = new Date(Date.parse(this.clock()) + 600000).toISOString()
      state.challenges ??= {}
      state.challenges[challenge] = { initiator: authority.actor, target, expiresAt }
      await this.save(state)
      return { challenge, expiresAt }
    })
  }
  async confirm(authority: MemoryAuthority, challenge: string): Promise<{ entityId: string }> {
    id(challenge)
    return this.files.locked(async () => {
      const state = await this.state(), entry = state.challenges?.[challenge]
      if (
        !entry || entry.consumedAt || entry.expiresAt <= this.clock()
        || memoryKey(entry.target) !== memoryKey(authority.actor)
      ) throw new Error('MEMORY_CONFIRMATION_DENIED')
      const initiator = memoryKey(entry.initiator), target = memoryKey(entry.target)
      const existing = state.bindings[initiator] ?? state.bindings[target]
      if (state.bindings[initiator] && state.bindings[target] && state.bindings[initiator] !== state.bindings[target]) {
        throw new Error('MEMORY_BINDING_COLLISION')
      }
      const entityId = existing ?? memoryKey({ ...entry.initiator, userId: `entity:${challenge}` })
      state.bindings[initiator] = entityId
      state.bindings[target] = entityId
      entry.consumedAt = this.clock()
      await this.save(state)
      return { entityId }
    })
  }
  async unbind(authority: MemoryAuthority): Promise<void> {
    await this.files.locked(async () => {
      const state = await this.state()
      delete state.bindings[memoryKey(authority.actor)]
      await this.save(state)
    })
  }
}
