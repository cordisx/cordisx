import path from 'node:path'
import { createHash } from 'node:crypto'
import { MemoryFiles } from './channel-memory-files.js'
import { ChannelMemoryStore } from './channel-memory-store.js'

export const channelPersonaTask = (operationId: string, sessionId?: string) =>
  sessionId ?? `dispatch-${createHash('sha256').update(operationId).digest('hex')}`

export interface PersonaBotAccount {
  adapterId: string
  accountId: string
  tenantId: string
}
export interface PersonaProfile {
  schemaVersion: 1
  personaId: string
  revision: number
  name: string
  identity: string
  style?: { language?: string; tone?: string; verbosity?: string; role?: string }
}
export interface PersonaTaskContext {
  schemaVersion: 1
  taskId: string
  personaId: string
  bindingRevision: number
  account: PersonaBotAccount
}
interface PersonaState {
  schemaVersion: 1
  revision: number
  profiles: Record<string, PersonaProfile>
  bindings: Record<string, { personaId: string; revision: number }>
  tasks: Record<string, PersonaTaskContext>
  overrides?: Record<string, PersonaProfile['style']>
}
function identifier(value: string): void {
  if (
    typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/u.test(value)
    || ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'].includes(value)
  ) {
    throw new Error('PERSONA_INVALID_ID')
  }
}
function accountKey(account: PersonaBotAccount): string {
  const fields = [account.adapterId, account.accountId, account.tenantId]
  if (fields.some(value => typeof value !== 'string' || !value || value.length > 512 || /[\0\r\n]/u.test(value))) {
    throw new Error('PERSONA_INVALID_ACCOUNT')
  }
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}
export class ChannelMemoryPersonas {
  private readonly files: MemoryFiles
  constructor(private readonly root: string) {
    this.files = new MemoryFiles(path.join(root, 'registry'))
  }
  private async state(): Promise<PersonaState> {
    try {
      const state = await this.files.read('state.json') as PersonaState
      if (
        state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision)
        || !state.profiles || !state.bindings || !state.tasks
      ) throw new Error('PERSONA_INVALID_STATE')
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, revision: 0, profiles: {}, bindings: {}, tasks: {} }
    }
  }
  private async save(state: PersonaState): Promise<void> {
    state.revision += 1
    await this.files.write('state.json', state)
  }
  async profile(
    personaId: string,
    name: string,
    identity: string,
    expectedRevision: number,
    style?: PersonaProfile['style'],
  ): Promise<PersonaProfile> {
    identifier(personaId)
    if (
      typeof name !== 'string' || !name.trim() || typeof identity !== 'string' || !identity.trim()
      || Buffer.byteLength(JSON.stringify({ name, identity })) > 2048
      || style && (Object.keys(style).some(key => !['language', 'tone', 'verbosity', 'role'].includes(key))
          || Object.values(style).some(value => typeof value !== 'string' || value.length > 256))
    ) throw new Error('PERSONA_PROFILE_BUDGET')
    return this.files.locked(async () => {
      const state = await this.state(), previous = state.profiles[personaId]
      if (expectedRevision !== (previous?.revision ?? 0)) throw new Error('PERSONA_REVISION_CONFLICT')
      const profile: PersonaProfile = { schemaVersion: 1, personaId, revision: expectedRevision + 1, name, identity }
      if (style) profile.style = style
      else if (previous?.style) profile.style = previous.style
      state.profiles[personaId] = profile
      await this.save(state)
      return profile
    })
  }
  async bind(account: PersonaBotAccount, personaId: string, expectedRevision: number): Promise<number> {
    identifier(personaId)
    const key = accountKey(account)
    return this.files.locked(async () => {
      const state = await this.state()
      if (!state.profiles[personaId]) throw new Error('PERSONA_NOT_FOUND')
      const previous = state.bindings[key]
      if (expectedRevision !== (previous?.revision ?? 0)) throw new Error('PERSONA_REVISION_CONFLICT')
      const revision = expectedRevision + 1
      state.bindings[key] = { personaId, revision }
      await this.save(state)
      return revision
    })
  }
  async resolveTask(taskId: string, account: PersonaBotAccount): Promise<PersonaTaskContext> {
    identifier(taskId)
    const key = accountKey(account)
    return this.files.locked(async () => {
      const state = await this.state(), pinned = state.tasks[taskId]
      if (pinned) {
        if (accountKey(pinned.account) !== key) throw new Error('PERSONA_TASK_ACCOUNT_MISMATCH')
        return pinned
      }
      const binding = state.bindings[key]
      if (!binding) throw new Error('PERSONA_ACCOUNT_UNBOUND')
      const context: PersonaTaskContext = {
        schemaVersion: 1,
        taskId,
        personaId: binding.personaId,
        bindingRevision: binding.revision,
        account: { ...account },
      }
      state.tasks[taskId] = context
      await this.save(state)
      return context
    })
  }
  async memoryForTask(taskId: string, account: PersonaBotAccount): Promise<ChannelMemoryStore> {
    const context = await this.resolveTask(taskId, account)
    return new ChannelMemoryStore(path.join(this.root, 'spaces', context.personaId, 'memory'))
  }
  async configured(account: PersonaBotAccount): Promise<boolean> {
    await this.files.prepare()
    return (await this.state()).bindings[accountKey(account)] !== undefined
  }
  async taskConfigured(taskId: string, account: PersonaBotAccount): Promise<boolean> {
    identifier(taskId)
    await this.files.prepare()
    const state = await this.state()
    return state.tasks[taskId] !== undefined || state.bindings[accountKey(account)] !== undefined
  }
  async inheritTask(sourceTask: string, targetTask: string): Promise<void> {
    identifier(sourceTask)
    identifier(targetTask)
    await this.files.locked(async () => {
      const state = await this.state(), source = state.tasks[sourceTask], target = state.tasks[targetTask]
      if (!source) throw new Error('PERSONA_TASK_UNAVAILABLE')
      if (target && target.personaId !== source.personaId) throw new Error('PERSONA_TASK_ACCOUNT_MISMATCH')
      state.tasks[targetTask] = { ...source, taskId: targetTask }
      await this.save(state)
    })
  }
  async contextSettings(
    personaId: string,
    conversationId: string,
    style: NonNullable<PersonaProfile['style']>,
    expectedRevision: number,
  ): Promise<number> {
    identifier(personaId)
    if (
      !conversationId || conversationId.length > 512 || !style || typeof style !== 'object'
      || Object.keys(style).some(key => !['language', 'tone', 'verbosity', 'role'].includes(key))
      || Object.values(style).some(value => typeof value !== 'string' || value.length > 256)
    ) throw new Error('PERSONA_INVALID_STYLE')
    return this.files.locked(async () => {
      const state = await this.state()
      if (state.revision !== expectedRevision || !state.profiles[personaId]) {
        throw new Error('PERSONA_REVISION_CONFLICT')
      }
      state.overrides ??= {}
      state.overrides[`${personaId}:${conversationId}`] = style
      await this.save(state)
      return state.revision
    })
  }
  async pinAlias(taskId: string, alias: string, account: PersonaBotAccount): Promise<void> {
    identifier(alias)
    const pinned = await this.resolveTask(taskId, account)
    await this.files.locked(async () => {
      const state = await this.state(), existing = state.tasks[alias]
      if (
        existing && (existing.personaId !== pinned.personaId || accountKey(existing.account) !== accountKey(account))
      ) {
        throw new Error('PERSONA_TASK_ACCOUNT_MISMATCH')
      }
      if (existing && existing.bindingRevision === pinned.bindingRevision) return
      state.tasks[alias] = { ...pinned, taskId: alias }
      await this.save(state)
    })
  }
  async bootstrap(taskId: string, account: PersonaBotAccount, conversationId?: string) {
    const context = await this.resolveTask(taskId, account)
    await this.files.prepare()
    const state = await this.state(), profile = state.profiles[context.personaId]
    if (!profile) throw new Error('PERSONA_NOT_FOUND')
    const capsule = {
      schemaVersion: 1 as const,
      personaId: context.personaId,
      revision: profile.revision,
      bindingRevision: context.bindingRevision,
      name: profile.name,
      identity: profile.identity,
      contextRevision: state.revision,
      style: {
        ...profile.style,
        ...(conversationId ? state.overrides?.[`${context.personaId}:${conversationId}`] : {}),
      },
      trust:
        'Configured identity preference, not system policy or access authority. Retrieved memories remain untrusted.',
      pointers: ['channel memory guide', 'channel memory navigate', 'channel memory search-page'],
    }
    if (Buffer.byteLength(JSON.stringify(capsule)) > 2048) throw new Error('PERSONA_CAPSULE_BUDGET')
    return capsule
  }
}
