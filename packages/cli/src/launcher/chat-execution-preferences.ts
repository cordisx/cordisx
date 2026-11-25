import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type CodexCreationSettings, parseCodexCreationSettings } from '../codex-creation-settings.js'
import { loadHomeConfig, updateHomeConfigAtomic } from '../config/home-config.js'
import {
  type ChatExecutionSettings,
  executionSettingsMatch,
  nativeExecutionStart,
  nativeExecutionTurn,
  observedExecutionSettings,
  parseChatExecutionSettings,
} from '../chat-execution-settings.js'

export interface ChatExecutionRecord {
  readonly hostId: string
  readonly threadId: string
  /** Creation choice, subsequently refreshed from native observations for display only. */
  capturedDefaults: ChatExecutionSettings
  readonly defaultsRevision: number
  revision: number
  override?: ChatExecutionSettings
  /** Creation-only fields unsupported by thread/start are consumed by the first accepted turn. */
  pendingCreation?: ChatExecutionSettings
  /** Exact last accepted request; a later settings event must confirm this revision. */
  submittedSettings?: ChatExecutionSettings
  application: 'saved' | 'submitted' | 'applied' | 'restricted' | 'unknown'
  effective?: Record<string, unknown>
  /** Native readback of an explicit model selection; uncertainty must survive a restart. */
  modelSelection?: { status: 'confirmed'; providerId: string; model: string } | { status: 'unknown' }
  appliedRevision?: number
  turnId?: string
  code?: string
}
interface Document {
  readonly schema: 'cordisx.chat-execution-preferences/v1'
  records: Record<string, ChatExecutionRecord>
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const key = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId])
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)

/** Profile-owned chat preferences. No shared Codex database and no Channel binding is a settings owner. */
export class ChatExecutionPreferences {
  private reviewProvider: string | undefined
  private reviewModels: ReadonlySet<string> | undefined
  bindReviewProvider(providerId: string | undefined, models?: readonly string[]) {
    this.reviewProvider = providerId
    this.reviewModels = models ? new Set(models) : undefined
  }
  private preparation?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
  private configurationObservation?: (threadId: string, value: unknown) => Promise<void>
  private finalizeConfiguration?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
  private readonly records: Document = { schema: 'cordisx.chat-execution-preferences/v1', records: {} }
  private tail: Promise<void> = Promise.resolve()
  private readonly pendingObservations = new Map<string, number>()
  private readonly unconfirmedObservations = new Set<string>()
  private readonly captures = new Map<string, {
    createdAt: number
    method: string
    threadId?: string
    settings: ChatExecutionSettings
    defaultsRevision: number
    revision: number
    params: Record<string, unknown>
  }>()
  private constructor(private readonly input: { file: string; configPath: string; appId: string; profileId: string }) {}
  static async open(input: { file: string; configPath: string; appId: string; profileId: string }) {
    const service = new ChatExecutionPreferences(input)
    try {
      const document = JSON.parse(await readFile(input.file, 'utf8')) as Document
      if (document.schema !== service.records.schema || !document.records) throw new Error('INVALID_EXECUTION_STORE')
      for (const record of Object.values(document.records)) {
        if (!identity(record.hostId) || !identity(record.threadId) || !Number.isSafeInteger(record.revision)) {
          throw new Error('INVALID_EXECUTION_STORE')
        }
        parseChatExecutionSettings(record.capturedDefaults)
        if (record.override) parseChatExecutionSettings(record.override)
        if (record.pendingCreation) parseChatExecutionSettings(record.pendingCreation)
        if (record.submittedSettings) parseChatExecutionSettings(record.submittedSettings)
      }
      service.records.records = document.records
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return service
  }
  private async mutate<T>(update: () => T): Promise<T> {
    let result!: T
    const task = this.tail.then(async () => {
      const before = structuredClone(this.records.records)
      let temporary: string | undefined
      try {
        result = update()
        if (JSON.stringify(before) === JSON.stringify(this.records.records)) return
        await mkdir(path.dirname(this.input.file), { recursive: true, mode: 0o700 })
        temporary = `${this.input.file}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(this.records) + '\n', { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.input.file)
      } catch (error) {
        this.records.records = before
        if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    })
    this.tail = task.catch(() => undefined)
    await task
    return result
  }
  async defaults() {
    const config = await loadHomeConfig(this.input.configPath)
    const profile = config.apps[this.input.appId]?.profiles[this.input.profileId]
    if (!profile) throw new Error('PROFILE_UNAVAILABLE')
    return structuredClone(profile.chatExecution ?? { revision: 0, settings: {} })
  }
  async creationDefaults() {
    const config = await loadHomeConfig(this.input.configPath)
    const profile = config.apps[this.input.appId]?.profiles[this.input.profileId]
    if (!profile) throw new Error('PROFILE_UNAVAILABLE')
    return structuredClone(profile.chatCreation ?? { revision: 0, settings: {} })
  }
  async setCreationDefaults(value: unknown, expectedRevision: number) {
    const settings: CodexCreationSettings = parseCodexCreationSettings(value)
    const config = await updateHomeConfigAtomic(current => {
      const app = current.apps[this.input.appId], profile = app?.profiles[this.input.profileId]
      if (!profile) throw new Error('PROFILE_UNAVAILABLE')
      if ((profile.chatCreation?.revision ?? 0) !== expectedRevision) throw new Error('REVISION_CONFLICT')
      return {
        ...current,
        apps: {
          ...current.apps,
          [this.input.appId]: {
            ...app,
            profiles: {
              ...app.profiles,
              [this.input.profileId]: { ...profile, chatCreation: { revision: expectedRevision + 1, settings } },
            },
          },
        },
      }
    }, this.input.configPath)
    return config.apps[this.input.appId]!.profiles[this.input.profileId]!.chatCreation!
  }
  bindConfiguration(
    prepare: NonNullable<ChatExecutionPreferences['preparation']>,
    observe: NonNullable<ChatExecutionPreferences['configurationObservation']>,
    finalize?: NonNullable<ChatExecutionPreferences['finalizeConfiguration']>,
  ) {
    this.preparation = prepare
    this.configurationObservation = observe
    if (finalize) this.finalizeConfiguration = finalize
  }
  async setDefaults(value: unknown, expectedRevision: number) {
    const settings = parseChatExecutionSettings(value)
    const config = await updateHomeConfigAtomic(current => {
      const app = current.apps[this.input.appId], profile = app?.profiles[this.input.profileId]
      if (!profile) throw new Error('PROFILE_UNAVAILABLE')
      if ((profile.chatExecution?.revision ?? 0) !== expectedRevision) throw new Error('REVISION_CONFLICT')
      return {
        ...current,
        apps: {
          ...current.apps,
          [this.input.appId]: {
            ...app,
            profiles: {
              ...app.profiles,
              [this.input.profileId]: { ...profile, chatExecution: { revision: expectedRevision + 1, settings } },
            },
          },
        },
      }
    }, this.input.configPath)
    return config.apps[this.input.appId]!.profiles[this.input.profileId]!.chatExecution!
  }
  read(hostId: string, threadId: string) {
    if (!identity(hostId) || !identity(threadId)) throw new Error('INVALID_THREAD')
    const current = this.records.records[key(hostId, threadId)]
    return current === undefined ? undefined : structuredClone(current)
  }
  async recordModelSelection(
    threadId: string,
    selection?: { providerId: string; model: string } | null,
    expected?: { value: ChatExecutionRecord['modelSelection'] },
  ) {
    if (
      !identity(threadId) || selection && (
          !identity(selection.providerId) || !selection.model.trim() || selection.model.length > 512
          || /[\u0000-\u001f\u007f]/u.test(selection.model)
        )
    ) {
      throw new Error('INVALID_MODEL_SELECTION')
    }
    return this.mutate(() => {
      const id = key('local', threadId)
      const record = this.records.records[id] ?? {
        hostId: 'local',
        threadId,
        capturedDefaults: {},
        defaultsRevision: 0,
        revision: 0,
        application: 'unknown' as const,
      }
      if (expected && !isDeepStrictEqual(record.modelSelection, expected.value)) {
        throw new Error('MODEL_SELECTION_CHANGED')
      }
      if (selection === null) delete record.modelSelection
      else record.modelSelection = selection ? { status: 'confirmed', ...selection } : { status: 'unknown' }
      if (selection) {
        record.effective = { ...record.effective, modelProvider: selection.providerId, model: selection.model }
      }
      this.records.records[id] = record
    })
  }
  async settled() {
    await this.tail
  }
  observationConfirmed(threadId: string) {
    return !this.unconfirmedObservations.has(threadId)
  }
  async set(hostId: string, threadId: string, value: unknown, expectedRevision: number) {
    if (!identity(hostId) || !identity(threadId)) throw new Error('INVALID_THREAD')
    const override = value === null ? undefined : parseChatExecutionSettings(value)
    return this.mutate(() => {
      const id = key(hostId, threadId)
      const current = this.records.records[id]
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error('REVISION_CONFLICT')
      // Editing an existing chat never captures today's defaults retroactively.
      const next: ChatExecutionRecord = {
        ...(current ?? { hostId, threadId, capturedDefaults: {}, defaultsRevision: 0 }),
        revision: expectedRevision + 1,
        application: 'saved',
      }
      delete next.code
      delete next.submittedSettings
      if (override === undefined) delete next.override
      else next.override = override
      this.records.records[id] = next
      return structuredClone(next)
    })
  }
  async prepare(method: string, value: unknown, context?: Record<string, unknown>) {
    const params = this.preparation ? await this.preparation(method, object(value)) : object(value)
    if (method === 'thread/settings/update' && this.reviewProvider) {
      const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
      const effective = threadId ? this.read('local', threadId)?.effective : undefined
      const provider = params.modelProvider ?? context?.modelProvider ?? effective?.modelProvider
      const model = params.model ?? context?.model ?? effective?.model
      if ((provider === undefined || model === undefined) && context === undefined) {
        return { params, contextRequired: true }
      }
      if (provider !== this.reviewProvider) throw new Error('REVIEW_PROVIDER_SCOPE_MISMATCH')
      if (typeof model !== 'string' || this.reviewModels && !this.reviewModels.has(model)) {
        throw new Error('REVIEW_PARENT_MODEL_NOT_IN_CATALOG')
      }
      return { params }
    }
    if (!['thread/start', 'thread/resume', 'turn/start'].includes(method)) return { params }
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    const current = threadId === undefined ? undefined : this.read('local', threadId)
    const defaults = method === 'thread/start' ? await this.defaults() : { revision: 0, settings: {} }
    const settings: ChatExecutionSettings = method === 'thread/start'
      ? defaults.settings
      : { ...(method === 'turn/start' ? current?.pendingCreation : {}), ...current?.override }
    let fields: Record<string, unknown>
    try {
      fields = method === 'turn/start'
        ? nativeExecutionTurn(settings, { ...current?.effective, ...context }, params)
        : nativeExecutionStart(settings)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'EXECUTION_UNAVAILABLE'
      if (context === undefined && ['EXECUTION_CONTEXT_UNAVAILABLE', 'WORK_MODE_MODEL_UNAVAILABLE'].includes(code)) {
        return { params, contextRequired: true }
      }
      if (current) {
        await this.mutate(() => {
          const record = this.records.records[key('local', current.threadId)]!
          record.application = 'restricted'
          record.code = error instanceof Error ? error.message : 'EXECUTION_UNAVAILABLE'
        })
      }
      throw error
    }
    if (params.permissions !== undefined && params.permissions !== null) {
      if (current?.override && (fields.sandbox !== undefined || fields.sandboxPolicy !== undefined)) {
        throw new Error('EXECUTION_NAMED_PROFILE_CONFLICT')
      }
      delete fields.sandbox
      delete fields.sandboxPolicy
    }
    // A concrete native UI selection wins over a creation default; a saved chat override owns its next turn.
    const selected = Object.fromEntries(
      Object.entries(params).filter(([field, value]) => value !== null || !(field in fields)),
    )
    let prepared: Record<string, unknown> = method === 'turn/start' && current?.override !== undefined
      ? { ...params, ...fields }
      : {
        ...fields,
        ...selected,
        ...(fields.config ? { config: { ...object(fields.config), ...object(params.config) } } : {}),
      }
    if (this.finalizeConfiguration) prepared = await this.finalizeConfiguration(method, prepared)
    if (this.reviewProvider) {
      if (
        ['model', 'model_provider', 'model_providers', 'model_catalog_json', 'profile'].some(
          key => object(prepared.config)[key] !== undefined,
        )
      ) throw new Error('REVIEW_NATIVE_CONFIG_CONFLICT')
      const provider = prepared.modelProvider ?? context?.modelProvider ?? current?.effective?.modelProvider
      if (provider === undefined && method === 'thread/start') prepared.modelProvider = this.reviewProvider
      else if (provider === undefined && context === undefined) return { params, contextRequired: true }
      else if (provider !== this.reviewProvider) throw new Error('REVIEW_PROVIDER_SCOPE_MISMATCH')
      const model = object(object(prepared.collaborationMode).settings).model ?? prepared.model ?? context?.model
        ?? current?.effective?.model
      if (typeof model !== 'string') {
        if (method !== 'thread/start' && context === undefined) return { params, contextRequired: true }
        throw new Error('REVIEW_PARENT_MODEL_REQUIRED')
      }
      if (typeof model === 'string' && this.reviewModels && !this.reviewModels.has(model)) {
        throw new Error('REVIEW_PARENT_MODEL_NOT_IN_CATALOG')
      }
    }
    const capturedSettings = (method === 'turn/start' || method === 'thread/start') && !current?.override
      ? {
        ...settings,
        ...observedExecutionSettings({
          sandbox: prepared.sandboxPolicy,
          approvalPolicy: prepared.approvalPolicy,
          reasoningEffort: object(object(prepared.collaborationMode).settings).reasoning_effort ?? prepared.effort
            ?? object(prepared.config).model_reasoning_effort,
          workMode: object(prepared.collaborationMode).mode,
        }),
      }
      : settings
    const captureId = randomUUID()
    for (const [id, item] of this.captures) if (Date.now() - item.createdAt > 120_000) this.captures.delete(id)
    if (this.captures.size >= 128) throw new Error('EXECUTION_CAPTURE_BUSY')
    this.captures.set(captureId, {
      createdAt: Date.now(),
      method,
      ...(threadId ? { threadId } : {}),
      settings: capturedSettings,
      defaultsRevision: defaults.revision,
      revision: current?.revision ?? 0,
      params: prepared,
    })
    return { params: prepared, captureId }
  }
  async complete(captureId: string, accepted: boolean, value: unknown) {
    const capture = this.captures.get(captureId)
    if (!capture) return
    this.captures.delete(captureId)
    const result = object(value), thread = object(result.thread)
    const threadId = typeof thread.id === 'string' ? thread.id : capture.threadId
    if (!threadId || !identity(threadId)) return
    await this.mutate(() => {
      const id = key('local', threadId)
      const current = this.records.records[id]
      const record: ChatExecutionRecord = current
        ?? {
          hostId: 'local',
          threadId,
          capturedDefaults: capture.settings,
          defaultsRevision: capture.defaultsRevision,
          revision: 0,
          application: 'unknown',
        }
      // An old acknowledgement cannot apply a newer saved selection.
      if (current && current.revision !== capture.revision) return
      if (!accepted) {
        record.application = 'restricted'
        record.code = 'NATIVE_EXECUTION_REJECTED'
      } else {
        const effective = { ...record.effective }
        for (
          const field of [
            'approvalPolicy',
            'approvalsReviewer',
            'sandbox',
            'cwd',
            'model',
            'modelProvider',
            'reasoningEffort',
            'activePermissionProfile',
            'serviceTier',
          ]
        ) {
          if (result[field] !== undefined) effective[field] = result[field]
          else if (thread[field] !== undefined) effective[field] = thread[field]
        }
        if (capture.method === 'turn/start' && typeof object(result.turn).id === 'string') {
          record.turnId = String(object(result.turn).id)
        }
        if (object(result.collaborationMode).mode) effective.workMode = object(result.collaborationMode).mode
        record.effective = effective
        if (capture.method === 'thread/start') {
          record.capturedDefaults = { ...capture.settings, ...observedExecutionSettings(effective) }
          record.pendingCreation = {
            ...(capture.settings.workMode === undefined || capture.settings.workMode === 'inherit'
              ? {}
              : { workMode: capture.settings.workMode }),
            ...(capture.settings.networkAccess === undefined
                || executionSettingsMatch({ networkAccess: capture.settings.networkAccess }, effective)
              ? {}
              : { networkAccess: capture.settings.networkAccess }),
          }
        } else if (capture.method === 'turn/start') {
          // Native selections made for the first turn supersede captured defaults. Defaults never become a sticky override.
          if (!record.override && record.pendingCreation) {
            const mode = object(capture.params.collaborationMode).mode
            if (mode === 'default' || mode === 'plan') {
              record.capturedDefaults = { ...record.capturedDefaults, workMode: mode }
            }
          }
          delete record.pendingCreation
        }
        record.appliedRevision = capture.revision
        const requested = capture.method === 'thread/start'
          ? { ...record.capturedDefaults, ...record.pendingCreation }
          : capture.settings
        record.submittedSettings = requested
        record.application = executionSettingsMatch(requested, effective) ? 'applied' : 'submitted'
        delete record.code
      }
      this.records.records[id] = record
    })
  }
  /** Native settings events are independent confirmation, including changes made in another window. */
  async observe(threadId: string, value: unknown) {
    if (!identity(threadId)) return
    await this.configurationObservation?.(threadId, value)
    const version = (this.pendingObservations.get(threadId) ?? 0) + 1
    this.pendingObservations.set(threadId, version)
    this.unconfirmedObservations.add(threadId)
    const native = object(value)
    await this.mutate(() => {
      const record = this.records.records[key('local', threadId)]
      if (!record) return
      const effective = { ...record.effective }
      for (
        const field of [
          'model',
          'modelProvider',
          'cwd',
          'approvalPolicy',
          'approvalsReviewer',
          'activePermissionProfile',
          'serviceTier',
        ]
      ) {
        if (native[field] !== undefined) effective[field] = native[field]
      }
      if (native.sandboxPolicy !== undefined) effective.sandbox = native.sandboxPolicy
      if (native.sandbox !== undefined) effective.sandbox = native.sandbox
      if (native.effort !== undefined) effective.reasoningEffort = native.effort
      if (native.reasoningEffort !== undefined) effective.reasoningEffort = native.reasoningEffort
      if (object(native.collaborationMode).mode) effective.workMode = object(native.collaborationMode).mode
      record.effective = effective
      if (record.modelSelection && (native.model !== undefined || native.modelProvider !== undefined)) {
        if (typeof native.model === 'string' && typeof native.modelProvider === 'string') {
          record.modelSelection = { status: 'confirmed', providerId: native.modelProvider, model: native.model }
        } else if (
          record.modelSelection.status === 'confirmed' && (
            native.model !== undefined && native.model !== record.modelSelection.model
            || native.modelProvider !== undefined && native.modelProvider !== record.modelSelection.providerId
          )
        ) record.modelSelection = { status: 'unknown' }
      }
      if (!record.override) {
        record.capturedDefaults = { ...record.capturedDefaults, ...observedExecutionSettings(effective) }
      }
      if (
        record.application !== 'saved'
        && executionSettingsMatch(
          record.submittedSettings ?? { ...record.pendingCreation, ...record.override },
          effective,
        )
      ) {
        record.application = 'applied'
        record.appliedRevision = record.revision
        delete record.code
      }
    })
    if (this.pendingObservations.get(threadId) === version) {
      this.pendingObservations.delete(threadId)
      this.unconfirmedObservations.delete(threadId)
    }
  }
  async close() {
    this.captures.clear()
    await this.tail
  }
}
