import { bindDiagnostic, diagnosticRef } from '../diagnostics/context.js'
import type { StartupProviderAdmission } from './startup-provider-admission.js'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import { NativeAgentTaskRouting } from './native-agent-task-routing.js'
import type { NativeSourceConfiguration } from './native-source-configuration.js'
import { isModelReasoningEffort } from '../model-reasoning-capabilities.js'
import type { CodexCreationSettings } from '../codex-creation-settings.js'
import { codexCreationSelection } from './codex-creation-selection.js'
import { nativeTaskEffort, nativeTaskSelectionAllowed } from './native-agent-task-effort.js'

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
  private readonly report = bindDiagnostic()
  private readonly intents = new Map<string, Intent>()
  private readonly active = new Map<string, Promise<unknown>>()
  private readonly fingerprints = new Map<string, string>()
  constructor(
    private readonly authority: {
      startup?: StartupProviderAdmission
      directory: string
      catalog(): Promise<readonly NativeModelProviderCatalogEntry[]>
      available(): Promise<boolean>
      invoke(
        input: { callId: string; sourceThreadId: string; sourceTurnId: string; arguments: Record<string, unknown> },
      ): Promise<unknown>
      sourceConfiguration?(threadId: string): Promise<NativeSourceConfiguration | undefined>
      creationDefaults?(): Promise<CodexCreationSettings>
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
    const sourceTurnId = turn?.turn_id ?? meta?.['openai/turnId'] ?? meta?.['openai/turn_id']
    const sourceCallId = meta?.['openai/toolCallId'] ?? meta?.['openai/tool_call_id'] ?? meta?.callId
      ?? (valid(turn?.turn_id) && ['string', 'number'].includes(typeof meta?.['cordisx/mcpRequestId'])
        ? `${turn.turn_id}:${String(meta!['cordisx/mcpRequestId'])}`
        : undefined)
    if (value?.thinking !== undefined && !isModelReasoningEffort(value.thinking)) {
      return { status: 'rejected', reason: 'invalid-reasoning-effort' }
    }
    if (
      !value || !valid(sourceThreadId) || !valid(sourceTurnId) || !valid(sourceCallId) || !valid(value.operationId, 128)
      || value.providerId !== undefined && !valid(value.providerId, 128)
      || value.model !== undefined && !valid(value.model)
      || value.fast !== undefined && typeof value.fast !== 'boolean'
      || typeof value.prompt !== 'string' || value.prompt.length === 0
      || value.prompt.length > 100_000 || value.prompt.includes('\0') || !object(value.target)
      || !validTarget(value.target) || (value.title !== undefined && !valid(value.title))
      || Object.keys(value).some(key =>
        !['operationId', 'providerId', 'model', 'fast', 'thinking', 'prompt', 'target', 'title'].includes(key)
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
    const run = this.run(key, fingerprint, sourceThreadId, sourceTurnId, sourceCallId, value)
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
    sourceTurnId: string,
    sourceCallId: string,
    value: Record<string, any>,
  ) {
    const file = path.join(this.authority.directory, `${key}.json`)
    try {
      const record = JSON.parse(await readFile(file, 'utf8'))
      return record.fingerprint === fingerprint
        ? record.result ?? { status: 'reconciliation-required', reason: 'native-creation-unconfirmed' }
        : { status: 'rejected', reason: 'operation-conflict' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'reconciliation-required' }
    }
    const earlyStartup = valid(value.providerId, 128) && valid(value.model)
      ? this.authority.startup?.availability(value.providerId, value.model)
      : undefined
    if (earlyStartup !== undefined && !earlyStartup.available) {
      return { status: 'unavailable', reason: earlyStartup.reason }
    }
    try {
      const selection = codexCreationSelection(
        await this.authority.creationDefaults?.() ?? {},
        value,
        await this.authority.catalog(),
      )
      if (!selection.providerId || !selection.model) {
        return { status: 'rejected', reason: 'creation-selection-required' }
      }
      value = { ...value, ...selection }
    } catch {
      return { status: 'rejected', reason: 'selection-outside-catalog' }
    }
    const startup = this.authority.startup?.availability(value.providerId, value.model)
    if (startup !== undefined && !startup.available) return { status: 'unavailable', reason: startup.reason }
    if (!await this.authority.available()) return { status: 'rejected', reason: 'native-task-adapter-unavailable' }
    if (this.intents.size >= 128) return { status: 'rejected', reason: 'native-task-pending-limit' }
    const catalog = await this.authority.catalog()
    if (
      !catalog.some(provider =>
        provider.providerId === value.providerId && provider.models.some(model => model.id === value.model)
      )
    ) {
      return { status: 'rejected', reason: 'selection-outside-catalog' }
    }
    const effort = nativeTaskEffort(catalog, value.providerId, value.model, value.thinking)
    if ('reason' in effort) return { status: 'rejected', reason: effort.reason }
    const callId = `cordisx-task-${createHash('sha256').update(sourceCallId).digest('hex')}-${randomUUID()}`
    const args = {
      prompt: value.prompt,
      target: value.target,
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(effort.effort === undefined ? {} : { thinking: effort.effort }),
    }
    await mkdir(this.authority.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.authority.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
      return { status: 'rejected', reason: 'intent-storage-unavailable' }
    }
    try {
      await writeFile(file, JSON.stringify({ fingerprint, callId, phase: 'dispatching' }), { flag: 'wx', mode: 0o600 })
    } catch {
      return { status: 'reconciliation-required', reason: 'intent-already-claimed' }
    }
    this.report({ event: 'native-task-create', phase: 'intent-recorded', requestRef: diagnosticRef(callId) })
    this.intents.set(callId, {
      callId,
      sourceThreadId,
      fingerprint: JSON.stringify(args),
      arguments: value,
      claimed: false,
    })
    let result: unknown
    try {
      const response = object(await this.authority.invoke({ callId, sourceThreadId, sourceTurnId, arguments: args }))
      const item = response?.content?.find((item: any) => item.type === 'text')
      let native: ReturnType<typeof nativeReceipt> = undefined
      let invalidResponse = false
      try {
        native = response?.isError === true ? undefined : nativeReceipt(item ? JSON.parse(item.text) : undefined)
      } catch {
        invalidResponse = true
      }
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
      this.report({
        event: 'native-task-create',
        phase: native ? 'native-receipt' : 'native-receipt-missing',
        reason: response?.isError === true ? 'native-tool-error' : invalidResponse ? 'invalid-native-response' : 'none',
        requestRef: diagnosticRef(callId),
      })
      if (native) {
        this.report({
          event: 'native-task-create',
          phase: 'route-result',
          outcome: String(object(result)?.status),
          requestRef: diagnosticRef(callId),
        })
      }
    } catch (error) {
      const missingSource = error instanceof Error && 'code' in error
        && error.code === 'NATIVE_TASK_SOURCE_THREAD_NOT_LOADED'
      result = missingSource
        ? { status: 'rejected', reason: 'native-source-thread-not-loaded' }
        : { status: 'reconciliation-required', reason: 'native-creation-unconfirmed' }
      this.report({
        event: 'native-task-create',
        phase: 'dispatch-failed',
        reason: missingSource ? 'native-source-thread-not-loaded' : 'native-request-failed',
        requestRef: diagnosticRef(callId),
      })
    }
    try {
      await writeFile(file, JSON.stringify({ fingerprint, callId, result }), { mode: 0o600 })
      if (object(result)?.status === 'created' || object(result)?.reason === 'native-source-thread-not-loaded') {
        this.authority.routing.retireCompleted(callId)
        this.intents.delete(callId)
      }
    } catch { /* Retain the live operation while its durable acknowledgement remains uncertain. */ }
    return result
  }

  async claim(input: unknown) {
    const request = object(input), intent = request && this.intents.get(request.callId)
    if (
      request && !intent && valid(request.callId) && !request.callId.startsWith('cordisx-task-')
      && valid(request.sourceThreadId) && request.hostId === 'local'
    ) {
      const source = await this.authority.sourceConfiguration?.(request.sourceThreadId)
      if (!source) return undefined
      const defaults = await this.authority.creationDefaults?.() ?? {}
      const selected = Object.keys(defaults).length
        ? codexCreationSelection(defaults, {
          providerId: defaults.providerId ?? source.providerId,
          ...(request.model != null
            ? { model: request.model }
            : defaults.model
            ? { model: defaults.model }
            : defaults.providerId === undefined || defaults.providerId === source.providerId
            ? { model: source.model }
            : {}),
          ...(request.serviceTier === undefined ? {} : { fast: request.serviceTier === 'priority' }),
        }, await this.authority.catalog())
        : {
          providerId: source.providerId,
          model: request.model ?? source.model,
          fast: request.serviceTier === undefined
            ? source.serviceTier === 'priority'
            : request.serviceTier === 'priority',
        }
      const model = selected.model ?? source.model
      const effort = request.thinking == null ? source.reasoningEffort : request.thinking
      const tier = selected.fast === undefined ? source.serviceTier : selected.fast ? 'priority' : null
      if (!isModelReasoningEffort(effort) || (tier !== null && tier !== 'priority')) return undefined
      if (
        !valid(model)
        || selected.providerId !== 'openai'
          && !(await this.authority.catalog()).some(provider =>
            provider.providerId === selected.providerId && provider.models.some(item => item.id === model)
          )
      ) return undefined
      return await this.authority.routing.prepare({
        callId: request.callId,
        sourceThreadId: request.sourceThreadId,
        providerId: selected.providerId ?? source.providerId,
        model,
        reasoningEffort: effort,
        serviceTier: tier,
        transient: true,
      })
    }
    if (
      !intent || intent.claimed || request.sourceThreadId !== intent.sourceThreadId || request.hostId !== 'local'
      || JSON.stringify(request.arguments) !== intent.fingerprint
    ) return undefined
    const startup = this.authority.startup?.availability(
      String(intent.arguments.providerId),
      String(intent.arguments.model),
    )
    if (startup !== undefined && !startup.available) throw new Error(`Native task unavailable: ${startup.reason}`)
    intent.claimed = true
    this.report({ event: 'native-task-create', phase: 'claim-matched', requestRef: diagnosticRef(intent.callId) })
    if (!await this.authority.available()) throw new Error('Native task adapter retired')
    const catalog = await this.authority.catalog()
    const providerId = intent.arguments.providerId, model = intent.arguments.model
    if (
      !valid(providerId, 128) || !valid(model) || !catalog.some(provider =>
        provider.providerId === providerId
        && provider.models.some(item => item.id === model)
      )
    ) {
      throw new Error('Native task selection unavailable')
    }
    const effort = nativeTaskEffort(
      catalog,
      providerId,
      model,
      intent.arguments.thinking,
    )
    if ('reason' in effort) throw new Error(`Native task effort unavailable: ${effort.reason}`)
    const explicitFast = typeof intent.arguments.fast === 'boolean'
    if (
      !nativeTaskSelectionAllowed(catalog, {
        providerId,
        model,
        ...(explicitFast ? { fastExplicit: true, serviceTier: intent.arguments.fast ? 'priority' : null } : {}),
      })
    ) throw new Error('Native task selection unavailable')
    const source = await this.authority.sourceConfiguration?.(intent.sourceThreadId)
    const handle = await this.authority.routing.prepare({
      callId: intent.callId,
      sourceThreadId: intent.sourceThreadId,
      providerId,
      model,
      ...(effort.effort !== undefined
        ? { reasoningEffort: effort.effort, reasoningExplicit: true }
        : source === undefined
        ? {}
        : { reasoningEffort: source.reasoningEffort }),
      ...(explicitFast
        ? { serviceTier: intent.arguments.fast ? 'priority' : null, fastExplicit: true }
        : source === undefined
        ? {}
        : { serviceTier: source.serviceTier }),
    })
    this.report({ event: 'native-task-create', phase: 'handle-prepared', requestRef: diagnosticRef(intent.callId) })
    return handle
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
