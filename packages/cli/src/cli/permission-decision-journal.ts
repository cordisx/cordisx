import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  type CordisXPersistedPermissionPolicyRecord,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'

/** These labels are selected by the service transport, never by a renderer. */
export type PermissionDecisionClient = 'web' | 'codex'

export interface PermissionDecisionEntry {
  readonly version: 1
  readonly id: string
  readonly profileId: string
  readonly client: PermissionDecisionClient
  readonly requestId: string
  readonly requestedAt: string
  /** Present only for a reviewed plugin lifecycle operation. The source stays private. */
  readonly lifecycle?: {
    readonly operation: 'install' | 'update' | 'enable'
    readonly identityKey: string
  }
  readonly changes: readonly {
    readonly pluginId: string
    readonly capability: string
    /** A digest avoids storing private plugin sources or permission scopes in the journal. */
    readonly key: string
    readonly policy: CordisXPersistedPermissionPolicyRecord['policy'] | 'allow-once' | 'deny-once'
  }[]
}

export type PermissionDecisionChoice = PermissionDecisionEntry['changes'][number]['policy']

/** The source digest is used for selection only and is never sent to a client. */
function lifecycleIdentityKey(profileId: string, identity: { readonly id: string; readonly source: string }): string {
  return createHash('sha256').update(JSON.stringify([profileId, identity.id, identity.source])).digest('hex')
}

export interface PermissionDecisionReceipt {
  readonly entry: PermissionDecisionEntry
  /** No receipt means the write may not have completed; it must not be shown as a grant. */
  readonly committedAt?: string
}

const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const REQUEST = /^[A-Za-z0-9-]{1,96}$/u
const EVENT = /^[a-f0-9]{32}$/u
const MAX_EVENT_BYTES = 32 * 1024
const HASH = /^[a-f0-9]{64}$/u
const POLICY = new Set(['ask', 'allow', 'deny', 'allow-persistent', 'deny-persistent', 'allow-once', 'deny-once'])

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
  ) throw new Error('permission-decision-journal-unavailable')
  return value as Record<string, unknown>
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

export function permissionDecisionKey(record: CordisXPersistedPermissionPolicyRecord): string {
  return createHash('sha256').update(persistedPermissionRecordKey(normalizePersistedPermissionPolicyRecord(record)))
    .digest('hex')
}

/**
 * Private service-owned write-ahead evidence. The entry is durable before a
 * policy mutation, and a separate receipt is durable only after all live
 * consumers have adopted it. An interrupted mutation remains explicitly
 * unconfirmed rather than being attributed as a successful grant.
 */
export class PermissionDecisionJournal {
  private readonly directory: string

  constructor(private readonly input: { readonly homeDir: string; readonly profileId: string }) {
    if (!path.isAbsolute(input.homeDir) || !PROFILE.test(input.profileId)) {
      throw new Error('permission-decision-journal-unavailable')
    }
    this.directory = path.join(input.homeDir, 'state', 'profiles', input.profileId, 'permission-decisions')
  }

  private privateEntry(stat: Stats, directory: boolean): void {
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : undefined
    if (
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
      || stat.isSymbolicLink() || uid !== undefined && stat.uid !== uid
      || (stat.mode & 0o077) !== 0
    ) throw new Error('permission-decision-journal-unavailable')
  }

  private async prepare(): Promise<void> {
    const directories = [
      this.input.homeDir,
      path.join(this.input.homeDir, 'state'),
      path.join(this.input.homeDir, 'state', 'profiles'),
      path.join(this.input.homeDir, 'state', 'profiles', this.input.profileId),
      this.directory,
    ]
    for (const [index, directory] of directories.entries()) {
      if (index > 0) {
        await mkdir(directory, { mode: 0o700 }).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
      }
      this.privateEntry(await lstat(directory), true)
    }
  }

  private async write(name: string, value: unknown): Promise<void> {
    const data = JSON.stringify(value)
    if (Buffer.byteLength(data) > MAX_EVENT_BYTES) throw new Error('permission-decision-journal-unavailable')
    const file = await open(
      path.join(this.directory, name),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      this.privateEntry(await file.stat(), false)
      await file.writeFile(data)
      await file.sync()
    } finally {
      await file.close()
    }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  async begin(input: {
    readonly client: PermissionDecisionClient
    readonly requestId: string
    readonly records: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly onceDecision?: 'allow-once' | 'deny-once'
    readonly lifecycle?: {
      readonly operation: 'install' | 'update' | 'enable'
      readonly decisions: readonly PermissionDecisionChoice[]
    }
  }): Promise<{ readonly id: string; commit(): Promise<void> }> {
    if (
      input.client !== 'web' && input.client !== 'codex' || !REQUEST.test(input.requestId)
      || input.records.length === 0 || input.records.length > 23
      || input.onceDecision !== undefined && input.onceDecision !== 'allow-once' && input.onceDecision !== 'deny-once'
      || input.onceDecision !== undefined && input.lifecycle !== undefined
    ) throw new Error('permission-decision-journal-unavailable')
    const records = input.records.map(item => normalizePersistedPermissionPolicyRecord(item))
    const first = records[0]!
    const decisions = input.lifecycle?.decisions
    if (
      records.some(record => record.key.profileId !== this.input.profileId)
      || new Set(records.map(permissionDecisionKey)).size !== records.length
      || input.onceDecision !== undefined && (records.length !== 1 || records[0]?.policy !== 'ask')
      || input.lifecycle !== undefined && (
          !['install', 'update', 'enable'].includes(input.lifecycle.operation)
          || !Array.isArray(decisions) || decisions.length !== records.length
          || records.some((record, index) => {
            const decision = decisions[index]
            return record.key.identity.pluginId !== first.key.identity.pluginId
              || record.key.identity.source !== first.key.identity.source
              || !decision || !POLICY.has(decision)
              || (decision === 'allow-once' || decision === 'deny-once') && record.policy !== 'ask'
              || decision === 'allow-persistent' && !['allow', 'allow-persistent'].includes(record.policy)
              || decision === 'deny-persistent' && !['deny', 'deny-persistent'].includes(record.policy)
              || ['ask', 'allow', 'deny'].includes(decision) && decision !== record.policy
          })
        )
    ) throw new Error('permission-decision-journal-unavailable')
    const id = randomBytes(16).toString('hex')
    const entry: PermissionDecisionEntry = {
      version: 1,
      id,
      profileId: this.input.profileId,
      client: input.client,
      requestId: input.requestId,
      requestedAt: new Date().toISOString(),
      ...(input.lifecycle === undefined ? {} : {
        lifecycle: {
          operation: input.lifecycle.operation,
          identityKey: lifecycleIdentityKey(this.input.profileId, {
            id: first.key.identity.pluginId,
            source: first.key.identity.source,
          }),
        },
      }),
      changes: records.map((record, index) => ({
        pluginId: record.key.identity.pluginId,
        capability: record.key.capability,
        key: permissionDecisionKey(record),
        policy: decisions?.[index] ?? input.onceDecision ?? record.policy,
      })),
    }
    await this.prepare()
    await this.write(`${id}.json`, entry)
    let committed = false
    return {
      id,
      commit: async () => {
        if (committed) throw new Error('permission-decision-journal-unavailable')
        committed = true
        await this.prepare()
        await this.write(`${id}.committed.json`, { version: 1, id, committedAt: new Date().toISOString() })
      },
    }
  }

  async read(id: string): Promise<PermissionDecisionReceipt> {
    if (!EVENT.test(id)) throw new Error('permission-decision-journal-unavailable')
    await this.prepare()
    const read = async (name: string) => {
      const file = await open(path.join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        this.privateEntry(stat, false)
        if (stat.size > MAX_EVENT_BYTES) throw new Error('permission-decision-journal-unavailable')
        return JSON.parse(await file.readFile('utf8')) as unknown
      } finally {
        await file.close()
      }
    }
    const rawEntry = await read(`${id}.json`)
    const withLifecycle = !!rawEntry && typeof rawEntry === 'object' && Object.hasOwn(rawEntry, 'lifecycle')
    const entry = object(rawEntry, [
      'version',
      'id',
      'profileId',
      'client',
      'requestId',
      'requestedAt',
      'changes',
      ...(withLifecycle ? ['lifecycle'] : []),
    ])
    if (
      entry.version !== 1 || entry.id !== id || entry.profileId !== this.input.profileId
      || entry.client !== 'web' && entry.client !== 'codex'
      || typeof entry.requestId !== 'string' || !REQUEST.test(entry.requestId) || !timestamp(entry.requestedAt)
      || !Array.isArray(entry.changes) || entry.changes.length === 0 || entry.changes.length > 23
    ) {
      throw new Error('permission-decision-journal-unavailable')
    }
    if (withLifecycle) {
      const lifecycle = object(entry.lifecycle, ['operation', 'identityKey'])
      if (
        !['install', 'update', 'enable'].includes(String(lifecycle.operation))
        || typeof lifecycle.identityKey !== 'string' || !HASH.test(lifecycle.identityKey)
      ) throw new Error('permission-decision-journal-unavailable')
    }
    const keys = new Set<string>()
    for (const rawChange of entry.changes) {
      const change = object(rawChange, ['pluginId', 'capability', 'key', 'policy'])
      if (
        typeof change.pluginId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(change.pluginId)
        || typeof change.capability !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/u.test(change.capability)
        || typeof change.key !== 'string' || !HASH.test(change.key) || keys.has(change.key)
        || typeof change.policy !== 'string' || !POLICY.has(change.policy)
      ) throw new Error('permission-decision-journal-unavailable')
      keys.add(change.key)
    }
    const captured = entry as unknown as PermissionDecisionEntry
    const raw = await read(`${id}.committed.json`).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (raw === undefined) return { entry: captured }
    const receipt = object(raw, ['version', 'id', 'committedAt'])
    if (receipt.version !== 1 || receipt.id !== id || !timestamp(receipt.committedAt)) {
      throw new Error('permission-decision-journal-unavailable')
    }
    return { entry: captured, committedAt: receipt.committedAt }
  }

  /** Project only exact owner-selected policy keys; callers cannot choose a private source. */
  async recent(
    records: readonly CordisXPersistedPermissionPolicyRecord[],
    limit = 100,
  ): Promise<readonly PermissionDecisionReceipt[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || records.length > 256) {
      throw new Error('permission-decision-journal-unavailable')
    }
    const selected = records.map(item => normalizePersistedPermissionPolicyRecord(item))
    if (selected.some(record => record.key.profileId !== this.input.profileId)) {
      throw new Error('permission-decision-journal-unavailable')
    }
    if (selected.length === 0) return []
    const keys = new Set(selected.map(permissionDecisionKey))
    await this.prepare()
    const names = await readdir(this.directory)
    const results: PermissionDecisionReceipt[] = []
    for (const name of names) {
      const match = /^([a-f0-9]{32})\.json$/u.exec(name)
      if (!match) continue
      const receipt = await this.read(match[1]!)
      const changes = receipt.entry.changes.filter(change => keys.has(change.key))
      if (changes.length === 0) continue
      results.push({ ...receipt, entry: { ...receipt.entry, changes } })
    }
    results.sort((a, b) =>
      b.entry.requestedAt.localeCompare(a.entry.requestedAt)
      || b.entry.id.localeCompare(a.entry.id)
    )
    return results.slice(0, limit)
  }

  /** Read lifecycle reviews only for the exact owner-selected plugin identity. */
  async recentLifecycle(
    identity: { readonly id: string; readonly source: string },
    limit = 100,
  ): Promise<readonly import('../permission-decision-history.js').PluginAuthorizationHistoryItem[]> {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(identity.id) || typeof identity.source !== 'string'
      || identity.source.length === 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    ) throw new Error('permission-decision-journal-unavailable')
    const identityKey = lifecycleIdentityKey(this.input.profileId, identity)
    await this.prepare()
    const names = await readdir(this.directory)
    const result: import('../permission-decision-history.js').PluginAuthorizationHistoryItem[] = []
    for (const name of names) {
      const match = /^([a-f0-9]{32})\.json$/u.exec(name)
      if (!match) continue
      const receipt = await this.read(match[1]!)
      if (receipt.entry.lifecycle?.identityKey !== identityKey) continue
      if (receipt.entry.changes.some(change => change.pluginId !== identity.id)) {
        throw new Error('permission-decision-journal-unavailable')
      }
      result.push({
        operation: receipt.entry.lifecycle.operation,
        client: receipt.entry.client,
        requestedAt: receipt.entry.requestedAt,
        ...(receipt.committedAt === undefined ? {} : { committedAt: receipt.committedAt }),
        decisions: receipt.entry.changes.map(change => ({ capability: change.capability, decision: change.policy })),
      })
    }
    result.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    return result.slice(0, limit)
  }
}
