import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import { NativeAgentTaskRouting } from './native-agent-task-routing.js'

const object = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
const valid = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
type Intent = {
  callId: string
  sourceThreadId: string
  fingerprint: string
  arguments: Record<string, unknown>
  claimed: boolean
}

/** Durable intent is written before native dispatch. Restart/timeout never repeats creation. */
export class NativeAgentTasks {
  private readonly intents = new Map<string, Intent>()
  private readonly active = new Map<string, Promise<unknown>>()
  private readonly fingerprints = new Map<string, string>()
  constructor(
    private readonly authority: {
      directory: string
      catalog(): Promise<readonly NativeModelProviderCatalogEntry[]>
      available(): Promise<boolean>
      invoke(input: { callId: string; sourceThreadId: string; arguments: Record<string, unknown> }): Promise<unknown>
      routing: NativeAgentTaskRouting
    },
  ) {}

  async create(input: unknown, metadata: unknown): Promise<unknown> {
    const value = object(input), meta = object(metadata)
    const turn = typeof meta?.['x-codex-turn-metadata'] === 'string'
      ? (() => {
        try {
          return JSON.parse(meta['x-codex-turn-metadata'])
        } catch {
          return undefined
        }
      })()
      : object(meta?.['x-codex-turn-metadata'])
    const sourceThreadId = turn?.thread_id ?? meta?.['openai/threadId']
    const sourceCallId = meta?.['openai/toolCallId'] ?? meta?.['openai/tool_call_id'] ?? meta?.callId
      ?? (valid(turn?.turn_id) && ['string', 'number'].includes(typeof meta?.['cordisx/mcpRequestId'])
        ? `${turn.turn_id}:${String(meta!['cordisx/mcpRequestId'])}`
        : undefined)
    if (
      !value || !valid(sourceThreadId) || !valid(sourceCallId) || !valid(value.operationId, 128)
      || !valid(value.providerId, 128)
      || !valid(value.model) || typeof value.prompt !== 'string' || value.prompt.length === 0
      || value.prompt.length > 100_000 || value.prompt.includes('\0') || !object(value.target)
      || !validTarget(value.target) || (value.title !== undefined && !valid(value.title))
      || Object.keys(value).some(key =>
        !['operationId', 'providerId', 'model', 'prompt', 'target', 'title', 'thinking'].includes(key)
      )
    ) return { status: 'rejected', reason: 'invalid-creation' }
    const fingerprint = createHash('sha256').update(JSON.stringify([sourceThreadId, value])).digest('hex')
    const key = createHash('sha256').update(sourceThreadId + '\0' + value.operationId).digest('hex')
    if (this.active.has(key)) {
      return this.fingerprints.get(key) === fingerprint
        ? await this.active.get(key)
        : { status: 'rejected', reason: 'operation-conflict' }
    }
    this.fingerprints.set(key, fingerprint)
    const run = this.run(key, fingerprint, sourceThreadId, sourceCallId, value)
    this.active.set(key, run)
    try {
      return await run
    } finally {
      this.active.delete(key)
      this.fingerprints.delete(key)
    }
  }

  private async run(
    key: string,
    fingerprint: string,
    sourceThreadId: string,
    sourceCallId: string,
    value: Record<string, any>,
  ) {
    const file = path.join(this.authority.directory, `${key}.json`)
    await mkdir(this.authority.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.authority.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
      return { status: 'rejected', reason: 'intent-storage-unavailable' }
    }
    try {
      const record = JSON.parse(await readFile(file, 'utf8'))
      return record.fingerprint === fingerprint
        ? record.result ?? { status: 'reconciliation-required', reason: 'native-creation-unconfirmed' }
        : { status: 'rejected', reason: 'operation-conflict' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'reconciliation-required' }
    }
    if (!await this.authority.available()) return { status: 'rejected', reason: 'native-task-adapter-unavailable' }
    const catalog = await this.authority.catalog()
    if (
      !catalog.some(provider =>
        provider.providerId === value.providerId && provider.models.some(model => model.id === value.model)
      )
    ) {
      return { status: 'rejected', reason: 'selection-outside-catalog' }
    }
    const callId = `cordisx-task-${createHash('sha256').update(sourceCallId).digest('hex')}-${randomUUID()}`
    const args = {
      prompt: value.prompt,
      target: value.target,
      ...(value.title === undefined ? {} : { title: value.title }),
    }
    try {
      await writeFile(file, JSON.stringify({ fingerprint, callId, phase: 'dispatching' }), { flag: 'wx', mode: 0o600 })
    } catch {
      return { status: 'reconciliation-required', reason: 'intent-already-claimed' }
    }
    this.intents.set(callId, {
      callId,
      sourceThreadId,
      fingerprint: JSON.stringify(args),
      arguments: value,
      claimed: false,
    })
    let result: unknown
    try {
      const response = object(await this.authority.invoke({ callId, sourceThreadId, arguments: args }))
      const item = response?.content?.find((item: any) => item.type === 'text')
      const native = nativeReceipt(item ? JSON.parse(item.text) : undefined)
      result = native && response?.isError !== true
        ? {
          status: valid(native.threadId) && this.authority.routing.confirmed(callId, native.threadId)
            ? 'created'
            : valid(native.clientThreadId) && this.authority.routing.claimed(callId)
            ? 'pending'
            : 'reconciliation-required',
          native,
        }
        : { status: 'reconciliation-required', reason: 'native-creation-unconfirmed' }
    } catch {
      result = { status: 'reconciliation-required', reason: 'native-creation-unconfirmed' }
    }
    await writeFile(file, JSON.stringify({ fingerprint, callId, result }), { mode: 0o600 }).catch(() => undefined)
    return result
  }

  async claim(input: unknown) {
    const request = object(input), intent = request && this.intents.get(request.callId)
    if (
      !intent || intent.claimed || request.sourceThreadId !== intent.sourceThreadId || request.hostId !== 'local'
      || JSON.stringify(request.arguments) !== intent.fingerprint
    ) return undefined
    intent.claimed = true
    if (!await this.authority.available()) throw new Error('Native task adapter retired')
    const catalog = await this.authority.catalog()
    if (
      !catalog.some(provider =>
        provider.providerId === intent.arguments.providerId
        && provider.models.some(model => model.id === intent.arguments.model)
      )
    ) {
      throw new Error('Native task selection unavailable')
    }
    return await this.authority.routing.prepare({
      callId: intent.callId,
      sourceThreadId: intent.sourceThreadId,
      providerId: String(intent.arguments.providerId),
      model: String(intent.arguments.model),
    })
  }
}

/** Only native task identity and settlement state are returned; raw native payloads stay private. */
function nativeReceipt(value: unknown): Record<string, any> | undefined {
  const native = object(value)
  if (!native) return undefined
  const result: Record<string, any> = {}
  for (
    const field of ['threadId', 'clientThreadId', 'conversationId', 'hostId', 'projectlessOutputDirectory', 'status']
  ) {
    if (valid(native[field], field === 'projectlessOutputDirectory' ? 4096 : 512)) result[field] = native[field]
  }
  const first = object(native.firstTurn)
  if (first && valid(first.status)) {
    result.firstTurn = {
      status: first.status,
      ...(valid(first.turnId) ? { turnId: first.turnId } : {}),
    }
  }
  return Object.keys(result).length ? result : undefined
}

function validTarget(target: Record<string, any>): boolean {
  if (target.type === 'projectless') {
    return Object.keys(target).every(key => ['type', 'directoryName'].includes(key))
      && (target.directoryName === undefined || valid(target.directoryName, 128))
  }
  if (
    target.type !== 'project' || !valid(target.projectId) || !object(target.environment)
    || !Object.keys(target).every(key => ['type', 'projectId', 'environment'].includes(key))
  ) return false
  const environment = target.environment
  if (!Object.keys(environment).every(key => ['type', 'startingState'].includes(key))) return false
  if (environment.type === 'local') return environment.startingState === undefined
  if (environment.type !== 'worktree') return false
  const state = environment.startingState
  return state === undefined || object(state) !== undefined && (
        state.type === 'working-tree' && Object.keys(state).length === 1
        || state.type === 'branch' && valid(state.branchName)
          && ['error', 'create-branch', undefined].includes(state.onMissing)
          && Object.keys(state).every(key => ['type', 'branchName', 'onMissing'].includes(key))
      )
}
