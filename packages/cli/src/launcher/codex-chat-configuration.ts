import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { parseCodexCreationSettings } from '../codex-creation-settings.js'
import { callerThreadId, callerTurnId } from './agent-bridge-context.js'
import type { ChatExecutionPreferences } from './chat-execution-preferences.js'
import type { CodexChatSettingsGuard } from './codex-chat-settings.js'
import { codexCreationSelection } from './codex-creation-selection.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value)
interface ProjectSelection {
  projectId: string
  cwd: string
  roots: string[]
}
interface Configuration {
  revision: number
  fast?: boolean
  project?: ProjectSelection
  application: 'saved' | 'submitted' | 'applied' | 'unknown'
}
interface NativeToolInput {
  tool: string
  sourceThreadId: string
  sourceTurnId?: string | undefined
  arguments: Record<string, unknown>
}
export interface CodexConfigurationAuthority {
  preferences: ChatExecutionPreferences
  file: string
  catalog?(): Promise<readonly NativeModelProviderCatalogEntry[]>
  request(method: NativeBridgeMethod, params: Record<string, unknown>): Promise<unknown>
  tool?(input: NativeToolInput): Promise<unknown>
  guard?: CodexChatSettingsGuard | undefined
}

/** Supplemental settings share the production app-server; paths and secrets never become plugin contracts. */
export class CodexChatConfiguration {
  private records: Record<string, Configuration> = {}
  private readonly observations = new Map<string, { revision: number; value: Record<string, unknown> }>()
  private readonly active = new Set<string>()
  private readonly hydrating = new Set<string>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()
  private constructor(private readonly authority: CodexConfigurationAuthority) {}
  catalog() {
    return this.authority.catalog?.() ?? Promise.resolve([])
  }
  async close() {
    this.closed = true
    await Promise.allSettled([...this.pending])
    await this.tail
  }
  static async open(authority: CodexConfigurationAuthority) {
    const service = new CodexChatConfiguration(authority)
    try {
      const document = JSON.parse(await readFile(authority.file, 'utf8'))
      if (document.schema !== 'cordisx.codex-chat-configuration/v1') throw new Error('INVALID_CHAT_CONFIGURATION')
      for (const [id, record] of Object.entries(object(document.records))) {
        const row = object(record), project = object(row.project)
        if (
          !identity(id) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
          || row.fast !== undefined && typeof row.fast !== 'boolean'
          || row.project !== undefined && (!identity(project.projectId) || !path.isAbsolute(String(project.cwd))
              || !Array.isArray(project.roots) || !project.roots.length
              || project.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root)))
        ) {
          throw new Error('INVALID_CHAT_CONFIGURATION')
        }
        service.records[id] = { ...row, application: 'unknown' } as unknown as Configuration
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    authority.preferences.bindConfiguration(
      (method, params) => service.prepare(method, params),
      (threadId, value) => service.observe(threadId, value),
      (method, params) => service.finalize(method, params),
    )
    return service
  }
  private async save(id: string, value: Configuration) {
    const task = this.tail.then(async () => {
      const next = { ...this.records, [id]: value }, temporary = `${this.authority.file}.${randomUUID()}.tmp`
      await mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 })
      try {
        await writeFile(
          temporary,
          JSON.stringify({ schema: 'cordisx.codex-chat-configuration/v1', records: next }) + '\n',
          { mode: 0o600, flag: 'wx' },
        )
        await rename(temporary, this.authority.file)
        this.records = next
      } finally {
        await rm(temporary, { force: true })
      }
    })
    this.tail = task.catch(() => undefined)
    await task
  }
  async observe(threadId: string, value: unknown) {
    this.observations.set(threadId, {
      revision: (this.observations.get(threadId)?.revision ?? 0) + 1,
      value: object(value),
    })
    if (this.observations.size > 512) this.observations.delete(this.observations.keys().next().value!)
  }
  private async observed(id: string, after: number) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const current = this.observations.get(id)
      if (current && current.revision > after) return current.value
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return undefined
  }
  private async nativeThread(id: string): Promise<Record<string, unknown>> {
    const result = object(await this.authority.request('thread/read', { threadId: id, includeTurns: false }))
    const thread = object(result.thread)
    if (thread.id !== id) throw new Error('SESSION_NOT_FOUND')
    let settings = this.observations.get(id)?.value ?? {}
    if (
      !this.hydrating.has(id) && object(thread.status).type === 'idle'
      && (!this.observations.has(id) && this.records[id] !== undefined
          && (thread.model === undefined || thread.sandbox === undefined)
        || settings.model === undefined && thread.model === undefined
          && this.authority.preferences.read('local', id)?.effective?.model === undefined
        || settings.sandboxPolicy === undefined && settings.sandbox === undefined && thread.sandbox === undefined
          && this.authority.preferences.read('local', id)?.effective?.sandbox === undefined)
    ) {
      // Older chats may predate this store. Resume the same loaded idle thread without changing selections.
      const before = this.observations.get(id)?.revision ?? 0
      this.hydrating.add(id)
      try {
        const resumed = object(await this.authority.request('thread/resume', { threadId: id }))
        if (object(resumed.thread).id !== id) throw new Error('CHAT_SETTINGS_UNAVAILABLE')
        const fresh = this.observations.get(id)
        settings = { ...resumed, ...(fresh && fresh.revision > before ? fresh.value : {}) }
        await this.observe(id, settings)
      } finally {
        this.hydrating.delete(id)
      }
    }
    return {
      ...this.authority.preferences.read('local', id)?.effective,
      ...thread,
      ...settings,
      id: thread.id,
      status: thread.status,
    }
  }
  async prepare(method: string, params: Record<string, unknown>) {
    if (this.closed) throw new Error('CHAT_CONFIGURATION_CLOSED')
    if (method === 'thread/start') {
      const defaults = (await this.authority.preferences.creationDefaults()).settings
      if (!Object.keys(defaults).length) return params
      const explicit = {
        ...(typeof params.modelProvider === 'string' ? { providerId: params.modelProvider } : {}),
        ...(typeof params.model === 'string' ? { model: params.model } : {}),
        ...(params.serviceTier === undefined ? {} : { fast: params.serviceTier === 'priority' }),
      }
      const selected = codexCreationSelection(defaults, explicit, await this.catalog())
      return {
        ...params,
        ...(selected.providerId ? { modelProvider: selected.providerId } : {}),
        ...(selected.model ? { model: selected.model } : {}),
        ...(selected.fast === undefined ? {} : { serviceTier: selected.fast ? 'priority' : null }),
      }
    }
    if (!['thread/resume', 'turn/start'].includes(method) || !identity(params.threadId)) return params
    if (this.hydrating.has(params.threadId)) return params
    const record = this.records[params.threadId]
    if (!record) return params
    let selected = { ...params }
    if (record.project) {
      const project = await this.project(record.project.projectId, record.project.cwd, params.threadId)
      if (JSON.stringify(project.roots) !== JSON.stringify(record.project.roots)) {
        throw new Error('PROJECT_ROOTS_CHANGED')
      }
      selected.cwd = project.cwd
      selected.permissions = null
    }
    if (record.fast !== undefined) {
      if (record.fast && !this.hydrating.has(params.threadId)) {
        const native = await this.nativeThread(params.threadId)
        await this.fastSupported({
          ...native,
          ...(typeof params.model === 'string' ? { model: params.model } : {}),
          ...(typeof params.modelProvider === 'string' ? { modelProvider: params.modelProvider } : {}),
        })
      }
      selected.serviceTier = record.fast ? 'priority' : null
    }
    return selected
  }
  private async finalize(method: string, params: Record<string, unknown>) {
    if (!['thread/resume', 'turn/start'].includes(method) || !identity(params.threadId)) return params
    if (this.hydrating.has(params.threadId)) return params
    const project = this.records[params.threadId]?.project
    if (!project) return params
    const native = await this.nativeThread(params.threadId)
    const sandbox = projectSandbox(project, params.sandboxPolicy ?? native.sandboxPolicy ?? native.sandbox)
    const selected: Record<string, unknown> = method === 'thread/resume'
      ? {
        ...params,
        ...projectResume(project, sandbox),
        config: { ...object(params.config), ...projectResume(project, sandbox).config },
      }
      : { ...params, cwd: project.cwd, permissions: null, sandboxPolicy: sandbox }
    const mode = object(selected.collaborationMode)
    if (mode.mode && object(mode.settings).model && typeof selected.model === 'string') {
      selected.collaborationMode = { ...mode, settings: { ...object(mode.settings), model: selected.model } }
    }
    return selected
  }
  private async fastSupported(native: Record<string, unknown>) {
    const catalog = await this.catalog()
    const provider = String(native.modelProvider ?? 'openai'), model = String(native.model ?? '')
    const supported = catalog.find(row => row.providerId === provider)?.models.some(row =>
      row.id === model && row.supportsFastMode === true
    )
    if (!supported) throw new Error('FAST_NOT_SUPPORTED')
  }
  private async project(
    projectId: string,
    cwd: string | undefined,
    caller: string,
    turn?: string,
  ): Promise<ProjectSelection> {
    if (!this.authority.tool) throw new Error('PROJECT_AUTHORITY_UNAVAILABLE')
    const result = toolResult(
      await this.authority.tool({
        tool: 'list_projects',
        sourceThreadId: caller,
        ...(turn ? { sourceTurnId: turn } : {}),
        arguments: {},
      }),
    )
    const entry = Array.isArray(result.projects)
      ? result.projects.map(object).find(row => row.projectId === projectId)
      : undefined
    if (!entry || entry.projectKind !== 'local' || entry.hostId !== 'local') throw new Error('PROJECT_UNAVAILABLE')
    const paths = Array.isArray(entry.rootPaths) ? entry.rootPaths : [entry.path]
    if (!paths.length || paths.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
      throw new Error('PROJECT_ROOTS_UNAVAILABLE')
    }
    const roots = await Promise.all((paths as string[]).map(async root => {
      const resolved = await realpath(root)
      if (!(await stat(resolved)).isDirectory()) throw new Error('PROJECT_ROOTS_UNAVAILABLE')
      await access(resolved, constants.R_OK | constants.X_OK)
      return resolved
    }))
    const directory = await realpath(cwd ?? roots[0]!)
    if (
      !roots.some(root => directory === root || directory.startsWith(root.endsWith('/') ? root : root + '/'))
      || !(await stat(directory)).isDirectory()
    ) throw new Error('CWD_OUTSIDE_PROJECT')
    return { projectId, cwd: directory, roots }
  }
  async call(operation: string, input: unknown, metadata?: unknown): Promise<unknown> {
    if (this.closed) return { status: 'unavailable', code: 'CHAT_CONFIGURATION_CLOSED' }
    const pending = this.run(operation, input, metadata)
    this.pending.add(pending)
    try {
      return await pending
    } finally {
      this.pending.delete(pending)
    }
  }
  private async run(operation: string, input: unknown, metadata?: unknown): Promise<unknown> {
    let id: string | undefined, claimed = false
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_REQUEST')
      const args = object(input), defaults = operation.startsWith('model-defaults')
      if (!['model-defaults', 'model-defaults-set', 'fast', 'fast-set', 'project', 'project-set'].includes(operation)) {
        throw new Error('INVALID_REQUEST')
      }
      const allowed = defaults
        ? operation.endsWith('-set') ? ['settings', 'expectedRevision'] : []
        : operation === 'project-set'
        ? ['sessionId', 'projectId', 'cwd', 'expectedRevision']
        : operation === 'fast-set'
        ? ['sessionId', 'fast', 'expectedRevision']
        : ['sessionId']
      if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST')
      id = defaults
        ? undefined
        : args.sessionId === undefined
        ? callerThreadId(metadata)
        : typeof args.sessionId === 'string'
        ? args.sessionId
        : undefined
      if (!defaults && !identity(id)) throw new Error('SESSION_REQUIRED')
      const guard = await this.authority.guard?.(operation, { ...args, ...(id ? { sessionId: id } : {}) }, metadata)
      if (guard !== undefined) return guard
      if (
        operation.endsWith('-set')
        && (!Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0)
      ) throw new Error('INVALID_REVISION')
      if (defaults) {
        if (operation === 'model-defaults') {
          return { status: 'ok', ...await this.authority.preferences.creationDefaults() }
        }
        const settings = parseCodexCreationSettings(args.settings)
        if (this.authority.catalog) codexCreationSelection(settings, {}, await this.catalog())
        return {
          status: 'ok',
          ...await this.authority.preferences.setCreationDefaults(settings, Number(args.expectedRevision)),
          validation: this.authority.catalog ? 'catalog' : 'deferred-until-creation',
        }
      }
      const native = await this.nativeThread(id!),
        current = this.records[id!] ?? { revision: 0, application: 'unknown' as const }
      if (!operation.endsWith('-set')) {
        return {
          status: 'ok',
          sessionId: id,
          ...current,
          effective: {
            ...(native.serviceTier === undefined ? {} : { fast: native.serviceTier === 'priority' }),
            cwd: native.cwd,
            ...(native.projectId === undefined ? {} : { projectId: native.projectId }),
            sandbox: native.sandboxPolicy ?? native.sandbox,
          },
        }
      }
      if (this.active.has(id!)) throw new Error('CHAT_SETTINGS_BUSY')
      if (current.revision !== args.expectedRevision) throw new Error('REVISION_CONFLICT')
      if (object(native.status).type !== 'idle') throw new Error('THREAD_NOT_IDLE')
      this.active.add(id!)
      claimed = true
      let next: Configuration = { ...current, revision: current.revision + 1, application: 'saved' }
      const params: Record<string, unknown> = { threadId: id }
      if (operation === 'fast-set') {
        if (typeof args.fast !== 'boolean') throw new Error('INVALID_FAST')
        if (args.fast) await this.fastSupported(native)
        next.fast = args.fast
        params.serviceTier = args.fast ? 'priority' : null
      } else {
        if (
          !identity(args.projectId)
          || args.cwd !== undefined && (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd))
        ) throw new Error('INVALID_PROJECT')
        const project = await this.project(
          args.projectId,
          args.cwd as string | undefined,
          callerThreadId(metadata) ?? id!,
          callerTurnId(metadata),
        )
        params.cwd = project.cwd
        params.sandboxPolicy = projectSandbox(project, native.sandboxPolicy ?? native.sandbox)
        params.permissions = null
        next.project = project
      }
      // Persist before native effects; uncertainty must not silently revert to the old directory or tier.
      const latest = await this.nativeThread(id!)
      if (object(latest.status).type !== 'idle') throw new Error('THREAD_NOT_IDLE')
      if (operation === 'fast-set' && args.fast === true) await this.fastSupported(latest)
      await this.save(id!, next)
      const before = this.observations.get(id!)?.revision ?? 0
      try {
        if (operation === 'project-set') {
          toolResult(
            await this.authority.tool!({
              tool: 'move_thread_to_project',
              sourceThreadId: callerThreadId(metadata) ?? id!,
              ...(callerTurnId(metadata) ? { sourceTurnId: callerTurnId(metadata) } : {}),
              arguments: { threadId: id, hostId: 'local', projectId: next.project!.projectId },
            }),
          )
        }
        await this.authority.request('thread/settings/update', params)
        const effective = await this.observed(id!, before)
        const confirmed = effective && (operation === 'fast-set'
          ? args.fast === true
            ? effective.serviceTier === 'priority'
            : effective.serviceTier === null || effective.serviceTier === 'default'
          : projectMatches(next.project!, effective) && await this.membership(id!, next.project!.projectId, metadata))
        next = { ...next, application: confirmed ? 'applied' : 'submitted' }
        await this.save(id!, next)
        return { status: next.application === 'applied' ? 'applied' : 'pending', sessionId: id, ...next }
      } catch {
        await this.save(id!, { ...next, application: 'unknown' })
        return { status: 'reconciliation-required', sessionId: id, ...next, application: 'unknown' }
      }
    } catch (error) {
      return {
        status: 'rejected',
        code: error instanceof Error && /^[A-Z_]+$/u.test(error.message)
          ? error.message
          : 'CHAT_CONFIGURATION_UNAVAILABLE',
      }
    } finally {
      if (id && claimed) this.active.delete(id)
    }
  }
  private async membership(id: string, projectId: string, metadata?: unknown) {
    if (!this.authority.tool) return false
    let cursor: string | undefined
    const cursors = new Set<string>()
    for (let page = 0; page < 20; page++) {
      const result = toolResult(
        await this.authority.tool({
          tool: 'list_threads',
          sourceThreadId: callerThreadId(metadata) ?? id,
          ...(callerTurnId(metadata) ? { sourceTurnId: callerTurnId(metadata) } : {}),
          arguments: { mode: 'history', source: 'codex', hostId: 'local', limit: 50, ...(cursor ? { cursor } : {}) },
        }),
      )
      const thread = Array.isArray(result.threads)
        ? result.threads.map(object).find(row => row.id === id && row.hostId === 'local')
        : undefined
      if (thread) return thread.projectId === projectId
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) return false
      cursor = result.nextCursor
      cursors.add(cursor)
    }
    return false
  }
}
function toolResult(value: unknown): Record<string, unknown> {
  const raw = object(value)
  if (raw.isError === true) throw new Error('NATIVE_TOOL_REJECTED')
  const block = Array.isArray(raw.content) ? raw.content.map(object).find(row => row.type === 'text') : undefined
  const result = raw.structuredContent
    ? object(raw.structuredContent)
    : typeof block?.text === 'string'
    ? object(JSON.parse(block.text))
    : undefined
  if (result) {
    if (result.error || ['rejected', 'failed', 'unavailable'].includes(String(result.status))) {
      throw new Error('NATIVE_TOOL_REJECTED')
    }
    return result
  }
  throw new Error('NATIVE_TOOL_UNCONFIRMED')
}
function projectSandbox(project: ProjectSelection, value: unknown) {
  const sandbox = object(value)
  if (sandbox.type === 'readOnly') return { ...sandbox, type: 'readOnly' }
  // Selecting a repository establishes a write boundary even for an old full-access chat.
  if (!['workspaceWrite', 'dangerFullAccess'].includes(String(sandbox.type))) {
    throw new Error('SANDBOX_CONTEXT_UNAVAILABLE')
  }
  return {
    type: 'workspaceWrite',
    writableRoots: project.roots,
    networkAccess: sandbox.networkAccess === true,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  }
}
function projectResume(project: ProjectSelection, sandbox: Record<string, unknown>) {
  return {
    cwd: project.cwd,
    runtimeWorkspaceRoots: project.roots,
    permissions: null,
    sandbox: sandbox.type === 'readOnly' ? 'read-only' : 'workspace-write',
    config: {
      'sandbox_workspace_write.writable_roots': project.roots,
      'sandbox_workspace_write.network_access': sandbox.networkAccess === true,
      'sandbox_workspace_write.exclude_tmpdir_env_var': true,
      'sandbox_workspace_write.exclude_slash_tmp': true,
    },
  }
}
function projectMatches(project: ProjectSelection, effective: Record<string, unknown>) {
  const sandbox = object(effective.sandboxPolicy ?? effective.sandbox)
  const actual = Array.isArray(sandbox.writableRoots)
    ? [...new Set([effective.cwd, ...sandbox.writableRoots])].sort()
    : []
  const expected = [...new Set([project.cwd, ...project.roots])].sort()
  return effective.cwd === project.cwd && (sandbox.type === 'readOnly' || sandbox.type === 'workspaceWrite'
      && JSON.stringify(actual) === JSON.stringify(expected)
      && sandbox.excludeTmpdirEnvVar === true && sandbox.excludeSlashTmp === true)
}
