import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DOCUMENT_VERSION = 1 as const
const RECOVERY_DAYS = 30
const EXPIRY_MARKER_DAYS = 32
const MAX_OPERATIONS = 2_048
const MAX_TASKS = 512
const MAX_DOCUMENT_BYTES = 1024 * 1024

export interface AgentLoopAuthorityScope {
  readonly profileId: string
  readonly compositionGeneration: string
  readonly ownerKey: string
}

export interface AgentLoopProviderFence {
  readonly providerId: string
  readonly providerGeneration: string
}

export interface AgentLoopTaskLocator extends AgentLoopProviderFence {
  readonly task: string
  readonly binding: { readonly bindingId: string; readonly generation: number }
  readonly remoteSessionId: string
  readonly definition: { readonly agentId: string; readonly revision: string }
  readonly state: 'active' | 'closed'
}

interface PersistedTask extends AgentLoopTaskLocator {
  readonly ownerDigest: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface PersistedOperation {
  readonly key: string
  readonly ownerDigest: string
  readonly operationIdDigest: string
  readonly commandDigest: string
  readonly kind: string
  readonly resourceDigest?: string
  readonly provider?: AgentLoopProviderFence
  readonly state: 'planned' | 'committed'
  readonly firstObservedAt: string
  readonly closedAt?: string
  readonly result?: unknown
}

interface ExpiredOperation {
  readonly key: string
  readonly ownerDigest: string
  readonly commandDigest: string
  readonly kind: string
  readonly expiredAt: string
  readonly markerExpiresAt: string
  readonly provider?: AgentLoopProviderFence
}

interface AuthorityDocument {
  readonly version: typeof DOCUMENT_VERSION
  readonly operations: readonly PersistedOperation[]
  readonly tasks: readonly PersistedTask[]
  readonly expiredOperations: readonly ExpiredOperation[]
}

export type AgentLoopPlanResult =
  | { readonly status: 'planned' }
  | { readonly status: 'replay'; readonly result: unknown }
  | { readonly status: 'conflict' }
  | { readonly status: 'resource-conflict' }
  | { readonly status: 'operation-expired' }
  | { readonly status: 'reconciliation-required'; readonly provider?: AgentLoopProviderFence }

export interface AgentLoopAuthorityCrashHooks {
  readonly afterPlan?: () => void
  readonly beforeCommit?: () => void
}

function digest(domain: string, value: string): string {
  return createHash('sha256').update(domain).update('\0').update(value).digest('base64url')
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}

function date(value: string): number | undefined {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function ownerDigest(scope: AgentLoopAuthorityScope): string {
  return digest(
    'cordisx.agent-loop.owner.v1',
    JSON.stringify([
      scope.profileId,
      scope.ownerKey,
    ]),
  )
}

function operationKey(scope: AgentLoopAuthorityScope, operationId: string): string {
  return digest('cordisx.agent-loop.operation.v1', `${ownerDigest(scope)}\0${operationId}`)
}

function occupiesResource(operation: PersistedOperation): boolean {
  if (operation.state === 'planned') return true
  const result = operation.result as { status?: unknown; introductionState?: unknown } | undefined
  return result?.status === 'accepted'
    && !(operation.kind === 'request-member-self-introduction' && result.introductionState === 'failed')
}

function safeDocument(value: unknown): AuthorityDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AgentLoop authority document is invalid')
  }
  const input = value as Partial<AuthorityDocument>
  if (input.version !== DOCUMENT_VERSION || !Array.isArray(input.operations) || !Array.isArray(input.tasks)) {
    throw new Error('AgentLoop authority document is invalid')
  }
  if (
    input.operations.length > MAX_OPERATIONS || input.tasks.length > MAX_TASKS
    || input.expiredOperations !== undefined
      && (!Array.isArray(input.expiredOperations) || input.expiredOperations.length > MAX_OPERATIONS)
  ) {
    throw new Error('AgentLoop authority quota is exceeded')
  }
  return clone(input as AuthorityDocument)
}

/**
 * Launcher-owned durable AgentLoop authority. Renderer/plugin values are
 * domain-separated before persistence; prompt, message and definition bodies
 * are never part of this document.
 */
export class AgentLoopAuthority {
  private document: AuthorityDocument = { version: DOCUMENT_VERSION, operations: [], tasks: [], expiredOperations: [] }
  private queue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly file: string,
    private readonly now: () => Date,
    private readonly crash: AgentLoopAuthorityCrashHooks,
  ) {}

  static async open(
    homeDir: string,
    profileId: string,
    options: { readonly now?: () => Date; readonly crash?: AgentLoopAuthorityCrashHooks } = {},
  ): Promise<AgentLoopAuthority> {
    if (!path.isAbsolute(homeDir) || !/^[A-Za-z0-9._-]{1,128}$/u.test(profileId)) {
      throw new Error('AgentLoop authority scope is invalid')
    }
    const directory = path.join(homeDir, 'state', 'profiles', profileId, 'agent-loop')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const authority = new AgentLoopAuthority(
      path.join(directory, 'authority.v1.json'),
      options.now ?? (() => new Date()),
      options.crash ?? {},
    )
    try {
      const encoded = await readFile(authority.file, 'utf8')
      if (Buffer.byteLength(encoded) > MAX_DOCUMENT_BYTES) {
        throw new Error('AgentLoop authority document exceeds its byte quota')
      }
      const restored = safeDocument(JSON.parse(encoded))
      authority.document = { ...restored, expiredOperations: restored.expiredOperations ?? [] }
      await chmod(authority.file, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await authority.mutate(() => undefined)
    return authority
  }

  async plan(input: {
    readonly scope: AgentLoopAuthorityScope
    readonly operationId: string
    readonly commandDigest: string
    readonly kind: string
    readonly provider?: AgentLoopProviderFence
    readonly resourceKey?: string
  }): Promise<AgentLoopPlanResult> {
    let output: AgentLoopPlanResult = { status: 'planned' }
    await this.mutate(document => {
      const key = operationKey(input.scope, input.operationId)
      const expired = document.expiredOperations.find(item => item.key === key)
      if (expired !== undefined) {
        output = input.provider !== undefined && expired.provider !== undefined
            && (input.provider.providerId !== expired.provider.providerId
              || input.provider.providerGeneration !== expired.provider.providerGeneration)
          ? { status: 'reconciliation-required', provider: clone(expired.provider) }
          : expired.commandDigest === input.commandDigest && expired.kind === input.kind
          ? { status: 'operation-expired' }
          : { status: 'conflict' }
        return
      }
      const existing = document.operations.find(item => item.key === key)
      if (existing !== undefined) {
        if (
          input.provider !== undefined && existing.provider !== undefined
          && (input.provider.providerId !== existing.provider.providerId
            || input.provider.providerGeneration !== existing.provider.providerGeneration)
        ) {
          output = { status: 'reconciliation-required', provider: clone(existing.provider) }
        } else if (existing.commandDigest !== input.commandDigest || existing.kind !== input.kind) {
          output = { status: 'conflict' }
        } else if (existing.state === 'committed') {
          output = input.provider !== undefined && existing.provider !== undefined
              && (existing.provider.providerId !== input.provider.providerId
                || existing.provider.providerGeneration !== input.provider.providerGeneration)
            ? { status: 'reconciliation-required', provider: clone(existing.provider) }
            : { status: 'replay', result: clone(existing.result) }
        } else {output = {
            status: 'reconciliation-required',
            ...(existing.provider === undefined ? {} : { provider: clone(existing.provider) }),
          }}
        return
      }
      const resourceDigest = input.resourceKey === undefined
        ? undefined
        : digest('cordisx.agent-loop.resource.v1', `${ownerDigest(input.scope)}\0${input.resourceKey}`)
      if (
        resourceDigest !== undefined && document.operations.some(item =>
          item.ownerDigest === ownerDigest(input.scope)
          && item.resourceDigest === resourceDigest
          && occupiesResource(item)
        )
      ) {
        output = { status: 'resource-conflict' }
        return
      }
      if (document.operations.length >= MAX_OPERATIONS) {
        output = {
          status: 'reconciliation-required',
          ...(input.provider === undefined ? {} : { provider: clone(input.provider) }),
        }
        return
      }
      const observedAt = this.now().toISOString()
      document.operations.push({
        key,
        ownerDigest: ownerDigest(input.scope),
        operationIdDigest: digest('cordisx.agent-loop.operation-id.v1', input.operationId),
        commandDigest: input.commandDigest,
        kind: input.kind,
        ...(resourceDigest === undefined ? {} : { resourceDigest }),
        ...(input.provider === undefined ? {} : { provider: clone(input.provider) }),
        state: 'planned',
        firstObservedAt: observedAt,
      })
    })
    this.crash.afterPlan?.()
    return output
  }

  async commit(input: {
    readonly scope: AgentLoopAuthorityScope
    readonly operationId: string
    readonly commandDigest: string
    readonly result: unknown
  }): Promise<void> {
    this.crash.beforeCommit?.()
    await this.mutate(document => {
      const key = operationKey(input.scope, input.operationId)
      const index = document.operations.findIndex(item => item.key === key)
      if (index < 0 || document.operations[index]!.commandDigest !== input.commandDigest) {
        throw new Error('AgentLoop operation was not planned')
      }
      const current = document.operations[index]!
      const accepted =
        (input.result as { status?: unknown; locator?: { state?: unknown } } | null)?.status === 'accepted'
        && (input.result as { locator?: { state?: unknown } }).locator?.state === 'active'
      document.operations[index] = {
        ...current,
        state: 'committed',
        result: clone(input.result),
        ...(accepted ? {} : { closedAt: this.now().toISOString() }),
      }
      if (
        current.kind === 'cancel-member-self-introduction'
        && (input.result as { status?: unknown; requestOperationId?: unknown } | null)?.status === 'accepted'
        && typeof (input.result as { requestOperationId?: unknown }).requestOperationId === 'string'
      ) {
        const requestKey = operationKey(
          input.scope,
          (input.result as { requestOperationId: string }).requestOperationId,
        )
        const requestIndex = document.operations.findIndex(item =>
          item.key === requestKey && item.state === 'committed'
          && item.kind === 'request-member-self-introduction'
        )
        if (requestIndex >= 0) {
          const request = document.operations[requestIndex]!
          document.operations[requestIndex] = {
            ...request,
            result: { ...(clone(request.result) as Record<string, unknown>), introductionState: 'cancelled' },
          }
        }
      }
    })
  }

  async rememberTask(scope: AgentLoopAuthorityScope, locator: AgentLoopTaskLocator): Promise<void> {
    await this.mutate(document => {
      const owner = ownerDigest(scope)
      const existing = document.tasks.findIndex(item => item.task === locator.task)
      if (existing >= 0 && document.tasks[existing]!.ownerDigest !== owner) {
        throw new Error('AgentLoop task crossed its owner scope')
      }
      const observedAt = this.now().toISOString()
      const task: PersistedTask = {
        ...clone(locator),
        ownerDigest: owner,
        createdAt: existing < 0 ? observedAt : document.tasks[existing]!.createdAt,
        updatedAt: observedAt,
      }
      if (existing < 0) document.tasks.push(task)
      else document.tasks[existing] = task
    })
  }

  resolveTask(scope: AgentLoopAuthorityScope, task: string): AgentLoopTaskLocator | undefined {
    const owner = ownerDigest(scope)
    const value = this.document.tasks.find(item => item.task === task && item.ownerDigest === owner)
    if (value === undefined) return undefined
    const { ownerDigest: _ownerDigest, createdAt: _createdAt, updatedAt: _updatedAt, ...locator } = value
    return clone(locator)
  }

  resolveBinding(
    scope: AgentLoopAuthorityScope,
    input: {
      readonly task: string
      readonly binding: { readonly bindingId: string; readonly generation: number }
      readonly definition: { readonly agentId: string; readonly revision: string }
    },
  ): AgentLoopTaskLocator | undefined {
    const locator = this.resolveTask(scope, input.task)
    if (
      locator === undefined || locator.state !== 'active'
      || locator.binding.bindingId !== input.binding.bindingId
      || locator.binding.generation !== input.binding.generation
      || locator.definition.agentId !== input.definition.agentId
      || locator.definition.revision !== input.definition.revision
    ) return undefined
    return locator
  }

  committedResult(scope: AgentLoopAuthorityScope, operationId: string): unknown | undefined {
    const value = this.document.operations.find(item =>
      item.key === operationKey(scope, operationId) && item.state === 'committed'
    )
    return value === undefined ? undefined : clone(value.result)
  }

  committedResults(scope: AgentLoopAuthorityScope): readonly { readonly kind: string; readonly result: unknown }[] {
    const owner = ownerDigest(scope)
    return this.document.operations
      .filter(item => item.ownerDigest === owner && item.state === 'committed')
      .map(item => ({ kind: item.kind, result: clone(item.result) }))
  }

  async observeIntroductionTerminal(
    provider: AgentLoopProviderFence,
    remoteSessionId: string,
    turn: string,
    state: 'completed' | 'failed',
  ): Promise<void> {
    await this.mutate(document => {
      for (let index = 0; index < document.operations.length; index += 1) {
        const operation = document.operations[index]!
        if (
          operation.state !== 'committed' || operation.kind !== 'request-member-self-introduction'
          || operation.provider?.providerId !== provider.providerId
          || operation.provider.providerGeneration !== provider.providerGeneration
        ) continue
        const result = operation.result as {
          status?: unknown
          turn?: unknown
          introductionState?: unknown
          locator?: { remoteSessionId?: unknown }
        } | undefined
        if (
          result?.status !== 'accepted' || result.turn !== turn || result.locator?.remoteSessionId !== remoteSessionId
          || result.introductionState !== undefined && result.introductionState !== 'pending'
        ) continue
        document.operations[index] = {
          ...operation,
          result: { ...(clone(operation.result) as Record<string, unknown>), introductionState: state },
        }
      }
    })
  }

  async closeProviderGeneration(provider: AgentLoopProviderFence): Promise<void> {
    await this.mutate(document => {
      const closedAt = this.now().toISOString()
      document.tasks = document.tasks.map(task =>
        task.providerId === provider.providerId
          && task.providerGeneration === provider.providerGeneration && task.state === 'active'
          ? { ...task, state: 'closed', updatedAt: closedAt }
          : task
      )
      document.operations = document.operations.map(operation =>
        operation.provider?.providerId === provider.providerId
          && operation.provider.providerGeneration === provider.providerGeneration && operation.closedAt === undefined
          ? { ...operation, closedAt }
          : operation
      )
    })
  }

  snapshotForTests(): AuthorityDocument {
    return clone(this.document)
  }

  private async mutate(
    change: (
      document: {
        version: 1
        operations: PersistedOperation[]
        tasks: PersistedTask[]
        expiredOperations: ExpiredOperation[]
      },
    ) => void,
  ): Promise<void> {
    let reject!: (error: unknown) => void
    let resolve!: () => void
    const result = new Promise<void>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    const previous = this.queue
    this.queue = (async () => {
      await previous
      try {
        const next = clone(this.document) as {
          version: 1
          operations: PersistedOperation[]
          tasks: PersistedTask[]
          expiredOperations: ExpiredOperation[]
        }
        this.gc(next)
        change(next)
        if (next.operations.length > MAX_OPERATIONS || next.tasks.length > MAX_TASKS) {
          throw new Error('AgentLoop authority quota is exceeded')
        }
        const encoded = `${JSON.stringify(next)}\n`
        if (Buffer.byteLength(encoded) > MAX_DOCUMENT_BYTES) {
          throw new Error('AgentLoop authority document exceeds its byte quota')
        }
        const temporary = `${this.file}.${randomUUID()}.tmp`
        await writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await chmod(temporary, 0o600)
        await rename(temporary, this.file)
        await chmod(this.file, 0o600)
        this.document = next
        resolve()
      } catch (error) {
        reject(error)
      }
    })().catch(() => undefined)
    return await result
  }

  private gc(
    document: { operations: PersistedOperation[]; tasks: PersistedTask[]; expiredOperations: ExpiredOperation[] },
  ): void {
    const now = this.now().getTime()
    const cutoff = this.now().getTime() - RECOVERY_DAYS * 24 * 60 * 60 * 1_000
    const expired = document.operations.filter(item =>
      item.closedAt === undefined
        ? item.state === 'planned' && (date(item.firstObservedAt) ?? 0) < cutoff
        : (date(item.closedAt) ?? 0) < cutoff
    )
    document.expiredOperations = [
      ...document.expiredOperations.filter(item => (date(item.markerExpiresAt) ?? 0) >= now),
      ...expired.flatMap(item => {
        const recoveryStart = date(item.closedAt ?? item.firstObservedAt) ?? 0
        const markerExpiresAt = recoveryStart + EXPIRY_MARKER_DAYS * 24 * 60 * 60 * 1_000
        return markerExpiresAt < now ? [] : [{
          key: item.key,
          ownerDigest: item.ownerDigest,
          commandDigest: item.commandDigest,
          kind: item.kind,
          expiredAt: this.now().toISOString(),
          markerExpiresAt: new Date(markerExpiresAt).toISOString(),
          ...(item.provider === undefined ? {} : { provider: clone(item.provider) }),
        }]
      }),
    ].slice(-MAX_OPERATIONS)
    const expiredKeys = new Set(expired.map(item => item.key))
    document.operations = document.operations.filter(item => !expiredKeys.has(item.key)).slice(-MAX_OPERATIONS)
    document.tasks = document.tasks.filter(item => item.state === 'active' || (date(item.updatedAt) ?? 0) >= cutoff)
      .slice(-MAX_TASKS)
  }
}

export function agentLoopCommandDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input === null || typeof input !== 'object') return input
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    )
  }
  return digest('cordisx.agent-loop.command.v1', JSON.stringify(canonical(value)))
}
