import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import type {
  EntityChange,
  EntityDefinitionResolution,
  EntityDigest,
  EntityFile,
  EntityOwnerScope,
  EntityPromptFile,
  EntityRecord,
  EntityRegistrySnapshot,
  EntitySaveRequest,
  EntitySaveResult,
  EntityTemplateDeclaration,
  EntityTemplateMaterializationResult,
} from '@cordisx/protocol/entities/v1'
import type { AgentDefinition, AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'

const ENTITY_FILE_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json' as const
const SNAPSHOT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-registry-snapshot.v1.schema.json' as const
const TEMPLATE_RESULT_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-template-materialization-result.v1.schema.json' as const
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MARKDOWN_PATH = /^\.\/prompts\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.md$/u
const TEMPLATE_PATH = /^\.\/entities\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/entity\.json$/u
const MAX_ENTITIES = 1_024
const MAX_PROMPTS = 64
const MAX_ENTITY_BYTES = 1_048_576
const MAX_PROMPT_BYTES = 1_048_576

export interface EntityDirectoryBinding extends EntityOwnerScope {
  readonly pluginGeneration: number
}

export interface EntityTemplatePayload {
  readonly declaration: EntityTemplateDeclaration
  /** Exact package bytes. They are hashed before any parsing or materialization. */
  readonly entityText: string
  readonly promptFiles: readonly EntityPromptFile[]
}

/** Read one package template without following a symlink outside its package. */
export async function readEntityTemplatePayload(
  packageRoot: string,
  declaration: EntityTemplateDeclaration,
): Promise<EntityTemplatePayload> {
  const root = await realpath(packageRoot)
  const canonical = `${root}${path.sep}`
  const load = async (relative: string): Promise<string> => {
    const unresolved = path.resolve(root, relative.slice(2))
    const resolved = await realpath(unresolved)
    const metadata = await lstat(resolved)
    if (!resolved.startsWith(canonical) || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('entity template file escapes package root')
    }
    return await readUtf8(resolved)
  }
  if (
    !TEMPLATE_PATH.test(declaration.entityPath)
    || !ENTITY_ID.test(declaration.agentId) || !/^sha256:[a-f0-9]{64}$/u.test(declaration.digest)
  ) throw new Error('entity template declaration is invalid')
  const entityText = await load(declaration.entityPath)
  const entity = parseEntityFile(entityText)
  if (entity.agentId !== declaration.agentId) throw new Error('entity template agentId does not match its declaration')
  const templateDirectory = path.posix.dirname(declaration.entityPath)
  const promptFiles = await Promise.all(
    referencedPromptPaths(entity).map(async promptPath => ({
      path: promptPath,
      text: await load(`${templateDirectory}/${promptPath.slice(2)}`),
    })),
  )
  if (entityTreeDigest(entityText, promptFiles) !== declaration.digest) {
    throw new Error('entity template digest mismatch')
  }
  return immutable({ declaration, entityText, promptFiles })
}

interface RegistryState {
  readonly record?: EntityRecord
  readonly invalid?: Extract<EntityChange, { readonly kind: 'entity-invalidated' }>['code']
}

interface MutationRecord {
  readonly fingerprint: string
  readonly result: EntitySaveResult
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}
function immutable<Value>(value: Value): Value {
  const output = clone(value)
  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || Object.isFrozen(candidate)) return
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child)
    Object.freeze(candidate)
  }
  freeze(output)
  return output
}
function ownerKey(owner: EntityOwnerScope): string {
  return JSON.stringify([owner.profileId, owner.installationId, owner.pluginId])
}
function sameOwner(left: EntityOwnerScope, right: EntityOwnerScope): boolean {
  return ownerKey(left) === ownerKey(right)
}
function changeOwner(change: EntityChange): EntityOwnerScope {
  if (change.kind === 'entity-added' || change.kind === 'entity-updated') return change.entity.owner
  return (change as Exclude<EntityChange, { readonly kind: 'entity-added' | 'entity-updated' }>).owner
}
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}
function u32(value: number): Buffer {
  const result = Buffer.allocUnsafe(4)
  result.writeUInt32BE(value)
  return result
}
function u64(value: number): Buffer {
  const result = Buffer.allocUnsafe(8)
  result.writeBigUInt64BE(BigInt(value))
  return result
}
async function readUtf8(file: string): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file))
}

/** Normative cordisx.entity-tree/v1 framed SHA-256 digest. */
export function entityTreeDigest(entityText: string, promptFiles: readonly EntityPromptFile[]): EntityDigest {
  const files = [
    { path: 'entity.json', bytes: Buffer.from(entityText, 'utf8') },
    ...promptFiles.map(file => ({ path: file.path.slice(2), bytes: Buffer.from(file.text, 'utf8') })),
  ].sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')))
  const digest = createHash('sha256').update('cordisx.entity-tree/v1').update(Buffer.from([0]))
  for (const file of files) {
    const logicalPath = Buffer.from(file.path, 'utf8')
    digest.update(u32(logicalPath.length)).update(logicalPath).update(u64(file.bytes.length)).update(file.bytes)
  }
  return `sha256:${digest.digest('hex')}`
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key))
  if (extra !== undefined) throw new Error(`${label}.${extra} is unsupported`)
}
function localId(value: string, label: string): string {
  if (!ENTITY_ID.test(value)) throw new Error(`${label} is invalid`)
  return value
}
function opaqueId(value: string, label: string): string {
  if (value.length < 1 || value.length > 512) throw new Error(`${label} is invalid`)
  return value
}

function referencedPromptPaths(entity: EntityFile): readonly EntityPromptFile['path'][] {
  const paths = (entity.promptSections ?? []).flatMap(section =>
    section.source.kind === 'markdown' ? [section.source.path] : []
  )
  if (new Set(paths).size !== paths.length) return [...new Set(paths)]
  return paths
}

function parseEntityFile(text: string): EntityFile {
  if (byteLength(text) > MAX_ENTITY_BYTES) throw new Error('entity file exceeds quota')
  const source = record(JSON.parse(text) as unknown, 'entity')
  exactKeys(source, [
    '$schema',
    'contract',
    'schemaVersion',
    'agentId',
    'name',
    'description',
    'avatar',
    'extends',
    'inherit',
    'promptSections',
    'rules',
    'skills',
    'tools',
    'mcpServers',
    'runtimeDefaults',
  ], 'entity')
  if (
    source.$schema !== ENTITY_FILE_SCHEMA || source.contract !== 'cordisx.entity-file/v1' || source.schemaVersion !== 1
    || typeof source.agentId !== 'string' || !ENTITY_ID.test(source.agentId)
  ) throw new Error('entity contract or agentId is invalid')
  if (
    source.name !== undefined && (typeof source.name !== 'string' || source.name.length < 1 || source.name.length > 256)
  ) throw new Error('entity name is invalid')
  if (
    source.description !== undefined && (typeof source.description !== 'string' || source.description.length > 2_000)
  ) throw new Error('entity description is invalid')
  const inherit = record(source.inherit, 'entity.inherit')
  exactKeys(
    inherit,
    ['promptSections', 'rules', 'skills', 'tools', 'mcpServers', 'runtimeDefaults', 'avatar'],
    'entity.inherit',
  )
  for (const key of ['promptSections', 'rules', 'skills'] as const) {
    if (!['none', 'replace', 'append', 'prepend', 'merge'].includes(String(inherit[key]))) {
      throw new Error(`entity.inherit.${key} is invalid`)
    }
  }
  for (const key of ['tools', 'mcpServers', 'runtimeDefaults'] as const) {
    if (!['none', 'replace', 'append', 'prepend', 'merge'].includes(String(inherit[key]))) {
      throw new Error(`entity.inherit.${key} is invalid`)
    }
  }
  if (inherit.avatar !== undefined && inherit.avatar !== 'inherit' && inherit.avatar !== 'none') {
    throw new Error('entity.inherit.avatar is invalid')
  }
  if (source.extends !== undefined) {
    if (!Array.isArray(source.extends) || source.extends.length > 32) throw new Error('entity.extends is invalid')
    const keys = source.extends.map((item, index) => {
      const identity = record(item, `entity.extends[${index}]`)
      exactKeys(identity, ['agentId', 'revision'], `entity.extends[${index}]`)
      if (
        typeof identity.agentId !== 'string' || !ENTITY_ID.test(identity.agentId)
        || typeof identity.revision !== 'string' || identity.revision === ''
      ) throw new Error('entity parent identity is invalid')
      return JSON.stringify([identity.agentId, identity.revision])
    })
    if (new Set(keys).size !== keys.length) throw new Error('entity parent identity is duplicated')
  }
  if (source.promptSections !== undefined) {
    if (!Array.isArray(source.promptSections) || source.promptSections.length > MAX_PROMPTS) {
      throw new Error('entity.promptSections is invalid')
    }
    const ids = source.promptSections.map((item, index) => {
      const section = record(item, `entity.promptSections[${index}]`)
      exactKeys(section, ['sectionId', 'kind', 'source'], `entity.promptSections[${index}]`)
      if (typeof section.sectionId !== 'string' || !ENTITY_ID.test(section.sectionId)) {
        throw new Error('entity prompt section id is invalid')
      }
      if (
        !['introduction', 'personality', 'role', 'operations', 'tools', 'knowledge', 'memory-policy', 'memory', 'other']
          .includes(String(section.kind))
      ) throw new Error('entity prompt kind is invalid')
      const promptSource = record(section.source, `entity.promptSections[${index}].source`)
      if (promptSource.kind === 'inline') {
        exactKeys(promptSource, ['kind', 'text'], `entity.promptSections[${index}].source`)
        if (typeof promptSource.text !== 'string' || promptSource.text.trim() === '') {
          throw new Error('inline prompt is invalid')
        }
      } else if (promptSource.kind === 'markdown') {
        exactKeys(promptSource, ['kind', 'path'], `entity.promptSections[${index}].source`)
        if (
          typeof promptSource.path !== 'string' || !MARKDOWN_PATH.test(promptSource.path)
          || promptSource.path.includes('..')
        ) throw new Error('markdown prompt path is invalid')
      } else throw new Error('entity prompt source is invalid')
      return section.sectionId
    })
    if (new Set(ids).size !== ids.length) throw new Error('entity prompt section id is duplicated')
  }
  return immutable(source as unknown as EntityFile)
}

function compile(
  entity: EntityFile,
  digest: EntityDigest,
  promptFiles: readonly EntityPromptFile[],
): EntityDefinitionResolution {
  const prompts = new Map(promptFiles.map(file => [file.path, file.text]))
  const definition: AgentDefinition = {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId: entity.agentId, revision: digest },
    ...(entity.name === undefined ? {} : { name: entity.name }),
    ...(entity.description === undefined ? {} : { description: entity.description }),
    ...(entity.avatar === undefined ? {} : { avatar: clone(entity.avatar) }),
    ...(entity.extends === undefined ? {} : { extends: clone(entity.extends) }),
    inherit: clone(entity.inherit),
    ...(entity.promptSections === undefined ? {} : {
      promptSections: entity.promptSections.map(section => ({
        sectionId: section.sectionId,
        kind: section.kind,
        text: section.source.kind === 'inline' ? section.source.text : prompts.get(section.source.path)!,
      })),
    }),
    ...(entity.rules === undefined ? {} : { rules: clone(entity.rules) }),
    ...(entity.skills === undefined ? {} : { skills: clone(entity.skills) }),
    ...(entity.tools === undefined ? {} : { tools: clone(entity.tools) }),
    ...(entity.mcpServers === undefined ? {} : { mcpServers: clone(entity.mcpServers) }),
    ...(entity.runtimeDefaults === undefined ? {} : { runtimeDefaults: clone(entity.runtimeDefaults) }),
  }
  return immutable({ identity: definition.identity, digest, definition })
}

async function syncedWrite(file: string, text: string): Promise<void> {
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class EntityDirectoryAuthority {
  readonly #homeDir: string
  readonly #profileId: string
  readonly #root: string
  readonly #ownersFile: string
  readonly #declarations = new Map<string, ReadonlyMap<string, EntityTemplateDeclaration>>()
  readonly #mutations = new Map<string, MutationRecord>()
  readonly #states = new Map<string, RegistryState>()
  readonly #changes: EntityChange[] = []
  #revision = 0
  #queue = Promise.resolve()

  constructor(homeDir: string, profileId: string) {
    this.#homeDir = path.resolve(homeDir)
    this.#profileId = localId(profileId, 'profileId')
    this.#root = path.join(this.#homeDir, 'profiles', this.#profileId, 'entities')
    this.#ownersFile = path.join(this.#homeDir, 'profiles', this.#profileId, 'entity-owners.v1.json')
  }

  register(binding: EntityDirectoryBinding, declarations: readonly EntityTemplateDeclaration[]): void {
    this.assertBinding(binding)
    const byId = new Map<string, EntityTemplateDeclaration>()
    for (const declaration of declarations) {
      if (
        !ENTITY_ID.test(declaration.agentId) || !TEMPLATE_PATH.test(declaration.entityPath)
        || declaration.entityPath !== `./entities/${declaration.agentId}/entity.json`
        || !/^sha256:[a-f0-9]{64}$/u.test(declaration.digest) || byId.has(declaration.agentId)
      ) throw new Error('entity template declaration is invalid')
      byId.set(declaration.agentId, immutable(declaration))
    }
    this.#declarations.set(ownerKey(binding), byId)
  }

  async materialize(
    binding: EntityDirectoryBinding,
    packageVersion: string,
    packageDigest: EntityDigest,
    templates: readonly EntityTemplatePayload[],
  ): Promise<readonly EntityTemplateMaterializationResult[]> {
    return await this.serial(async () => {
      this.assertBinding(binding)
      const owner = this.owner(binding)
      const output: EntityTemplateMaterializationResult[] = []
      for (const template of templates) {
        const envelope = {
          $schema: TEMPLATE_RESULT_SCHEMA,
          contract: 'cordisx.entity-template-materialization-result/v1' as const,
          schemaVersion: 1 as const,
          owner,
          packageVersion,
          packageDigest,
          agentId: template.declaration.agentId,
        }
        const expected = this.#declarations.get(ownerKey(owner))?.get(template.declaration.agentId)
        if (expected === undefined || JSON.stringify(expected) !== JSON.stringify(template.declaration)) {
          output.push({ ...envelope, status: 'rejected', code: 'invalid-template' })
          continue
        }
        const target = this.entityDirectory(template.declaration.agentId)
        const existing = await this.pathExists(target)
        if (existing) {
          const metadata = await lstat(target)
          if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            output.push({ ...envelope, status: 'rejected', code: 'symlink-escape' })
            continue
          }
          const owners = await this.readOwners()
          const existingOwner = owners[template.declaration.agentId]
          if (existingOwner !== undefined && !sameOwner(existingOwner, owner)) {
            output.push({ ...envelope, status: 'rejected', code: 'ownership-conflict' })
            continue
          }
          if (existingOwner === undefined) {
            if (Object.keys(owners).length >= MAX_ENTITIES) {
              output.push({ ...envelope, status: 'rejected', code: 'quota-authorization-required' })
              continue
            }
            await this.writeOwners({ ...owners, [template.declaration.agentId]: owner })
          }
          output.push({ ...envelope, status: 'preserved', code: 'entity-present' })
          continue
        }
        let source: ReturnType<typeof this.validateSource>
        try {
          source = this.validateSource(template.entityText, template.promptFiles, template.declaration.agentId)
        } catch {
          output.push({ ...envelope, status: 'rejected', code: 'invalid-template' })
          continue
        }
        if (source.digest !== template.declaration.digest) {
          output.push({ ...envelope, status: 'rejected', code: 'template-digest-mismatch' })
          continue
        }
        const owners = await this.readOwners()
        if (
          owners[template.declaration.agentId] !== undefined && !sameOwner(owners[template.declaration.agentId]!, owner)
        ) {
          output.push({ ...envelope, status: 'rejected', code: 'ownership-conflict' })
          continue
        }
        if (Object.keys(owners).length >= MAX_ENTITIES) {
          output.push({ ...envelope, status: 'rejected', code: 'quota-authorization-required' })
          continue
        }
        try {
          if (owners[template.declaration.agentId] === undefined) {
            await this.writeOwners({ ...owners, [template.declaration.agentId]: owner })
          }
          await this.publishTree(template.declaration.agentId, template.entityText, template.promptFiles, false)
          const entity = this.entityRecord(owner, source.resolution, 'materialized-template')
          await this.refresh()
          output.push({ ...envelope, status: 'materialized', code: 'created', entity })
        } catch {
          if (owners[template.declaration.agentId] === undefined) await this.writeOwners(owners).catch(() => undefined)
          output.push({ ...envelope, status: 'rejected', code: 'symlink-escape' })
        }
      }
      return immutable(output)
    })
  }

  async snapshot(binding: EntityDirectoryBinding): Promise<EntityRegistrySnapshot> {
    return await this.serial(async () => {
      this.assertBinding(binding)
      await this.refresh()
      const owner = this.owner(binding)
      const entities = [...this.#states.values()].flatMap(state =>
        state.record !== undefined && sameOwner(state.record.owner, owner) ? [state.record] : []
      )
        .sort((left, right) => left.identity.agentId.localeCompare(right.identity.agentId))
      return immutable({
        $schema: SNAPSHOT_SCHEMA,
        contract: 'cordisx.entity-registry-snapshot/v1',
        schemaVersion: 1,
        binding,
        registryRevision: this.#revision,
        entities,
      })
    })
  }

  async get(binding: EntityDirectoryBinding, identity: AgentDefinitionIdentity): Promise<EntityRecord | undefined> {
    return await this.serial(async () => {
      this.assertBinding(binding)
      await this.refresh()
      const record = this.#states.get(identity.agentId)?.record
      return record !== undefined && sameOwner(record.owner, this.owner(binding))
          && record.identity.revision === identity.revision
        ? immutable(record)
        : undefined
    })
  }

  async save(binding: EntityDirectoryBinding, request: EntitySaveRequest): Promise<EntitySaveResult> {
    return await this.serial(async () => {
      this.assertBinding(binding)
      const owner = this.owner(binding)
      let source: ReturnType<typeof this.validateSource>
      try {
        source = this.validateSource(
          `${JSON.stringify(request.entity, null, 2)}\n`,
          request.promptFiles,
          request.entity.agentId,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        const code = message.includes('prompt path')
          ? 'invalid-prompt-path'
          : message.includes('missing prompt')
          ? 'missing-prompt-file'
          : message.includes('unexpected prompt')
          ? 'unexpected-prompt-file'
          : message.includes('duplicate prompt')
          ? 'duplicate-prompt-file'
          : 'invalid-entity'
        return { status: 'rejected', code }
      }
      if (this.#declarations.get(ownerKey(owner))?.has(request.entity.agentId) !== true) {
        return { status: 'rejected', code: 'entity-not-declared' }
      }
      const mutationKey = `${ownerKey(owner)}\0${request.mutationId}`
      const fingerprint = JSON.stringify(request)
      const prior = this.#mutations.get(mutationKey)
      if (prior !== undefined) {
        return prior.fingerprint === fingerprint
          ? prior.result.status === 'applied'
            ? immutable({ ...prior.result, disposition: 'replayed' })
            : immutable(prior.result)
          : { status: 'conflict', code: 'mutation-conflict' }
      }
      await this.refresh()
      const current = this.#states.get(request.entity.agentId)?.record
      const result = await (async (): Promise<EntitySaveResult> => {
        if (request.expectedRevision === null && current !== undefined) {
          return { status: 'conflict', code: 'entity-exists', currentRevision: current.digest }
        }
        if (
          request.expectedRevision !== null
          && (current === undefined || !sameOwner(current.owner, owner)
            || current.identity.revision !== request.expectedRevision)
        ) {
          return {
            status: 'conflict',
            code: 'revision-conflict',
            ...(current === undefined ? {} : { currentRevision: current.digest }),
          }
        }
        const owners = await this.readOwners()
        if (current === undefined && Object.keys(owners).length >= MAX_ENTITIES) {
          return { status: 'rejected', code: 'quota-authorization-required' }
        }
        if (owners[request.entity.agentId] !== undefined && !sameOwner(owners[request.entity.agentId]!, owner)) {
          return { status: 'rejected', code: 'sharing-authorization-required' }
        }
        try {
          const text = `${JSON.stringify(request.entity, null, 2)}\n`
          if (current === undefined) await this.writeOwners({ ...owners, [request.entity.agentId]: owner })
          try {
            await this.publishTree(request.entity.agentId, text, request.promptFiles, current !== undefined)
          } catch (error) {
            if (current === undefined) await this.writeOwners(owners).catch(() => undefined)
            throw error
          }
          await this.refresh()
          const entity = this.#states.get(request.entity.agentId)?.record
          if (entity === undefined) return { status: 'unavailable', code: 'host-unavailable' }
          return { status: 'applied', disposition: current === undefined ? 'created' : 'updated', entity }
        } catch {
          return { status: 'rejected', code: 'symlink-escape' }
        }
      })()
      this.#mutations.set(mutationKey, { fingerprint, result: immutable(result) })
      return immutable(result)
    })
  }

  async changes(
    binding: EntityDirectoryBinding,
    afterRevision: number,
    replayThrough: number,
  ): Promise<{ readonly revision: number; readonly changes: readonly EntityChange[] }> {
    return await this.serial(async () => {
      this.assertBinding(binding)
      await this.refresh()
      const owner = this.owner(binding)
      const upper = replayThrough > afterRevision ? Math.min(replayThrough, this.#revision) : this.#revision
      return immutable({
        revision: this.#revision,
        changes: this.#changes.filter(change => {
          return change.sequence > afterRevision && change.sequence <= upper && sameOwner(changeOwner(change), owner)
        }),
      })
    })
  }

  private owner(binding: EntityDirectoryBinding): EntityOwnerScope {
    return { profileId: binding.profileId, installationId: binding.installationId, pluginId: binding.pluginId }
  }
  private assertBinding(binding: EntityDirectoryBinding): void {
    if (
      binding.profileId !== this.#profileId || !Number.isSafeInteger(binding.pluginGeneration)
      || binding.pluginGeneration < 1
    ) throw new Error('entity registry binding is stale')
    opaqueId(binding.installationId, 'installationId')
    localId(binding.pluginId, 'pluginId')
  }
  private entityDirectory(agentId: string): string {
    if (!ENTITY_ID.test(agentId)) throw new Error('agentId is invalid')
    return path.join(this.#root, agentId)
  }
  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await lstat(candidate)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  private async serial<Value>(operation: () => Promise<Value>): Promise<Value> {
    const next = this.#queue.then(operation, operation)
    this.#queue = next.then(() => undefined, () => undefined)
    return await next
  }
  private validateSource(
    entityText: string,
    promptFiles: readonly EntityPromptFile[],
    expectedAgentId: string,
  ): { readonly resolution: EntityDefinitionResolution; readonly digest: EntityDigest } {
    const entity = parseEntityFile(entityText)
    if (entity.agentId !== expectedAgentId) throw new Error('entity agentId differs from its directory')
    if (promptFiles.length > MAX_PROMPTS) throw new Error('prompt quota exceeded')
    const prompts = new Map<EntityPromptFile['path'], string>()
    for (const file of promptFiles) {
      if (!MARKDOWN_PATH.test(file.path) || file.path.includes('..')) throw new Error('prompt path is invalid')
      if (prompts.has(file.path)) throw new Error('duplicate prompt file')
      if (typeof file.text !== 'string' || byteLength(file.text) > MAX_PROMPT_BYTES) {
        throw new Error('prompt file is invalid')
      }
      prompts.set(file.path, file.text)
    }
    const referenced = referencedPromptPaths(entity)
    if (referenced.some(file => !prompts.has(file))) throw new Error('missing prompt file')
    if ([...prompts.keys()].some(file => !referenced.includes(file))) throw new Error('unexpected prompt file')
    const normalized = [...prompts].map(([promptPath, text]) => ({ path: promptPath, text }))
    const digest = entityTreeDigest(entityText, normalized)
    return { digest, resolution: compile(entity, digest, normalized) }
  }
  private entityRecord(
    owner: EntityOwnerScope,
    resolution: EntityDefinitionResolution,
    origin: EntityRecord['origin'],
  ): EntityRecord {
    return immutable({ ...resolution, owner, access: 'owned', origin })
  }
  private async ensureRoot(): Promise<void> {
    const profileRoot = path.dirname(this.#root)
    await mkdir(this.#homeDir, { recursive: true, mode: 0o700 })
    const homeMetadata = await lstat(this.#homeDir)
    if (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink()) {
      throw new Error('CordisX data root must be a real directory')
    }
    for (const candidate of [path.join(this.#homeDir, 'profiles'), profileRoot, this.#root]) {
      await mkdir(candidate, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      const metadata = await lstat(candidate)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('entity directory ancestor must be a real directory')
      }
      if (process.platform !== 'win32') await chmod(candidate, 0o700)
    }
  }
  private async readOwners(): Promise<Record<string, EntityOwnerScope>> {
    await this.ensureRoot()
    try {
      const metadata = await lstat(this.#ownersFile)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('entity ownership metadata must be a real file')
      }
      const source = record(JSON.parse(await readUtf8(this.#ownersFile)) as unknown, 'entity ownership metadata')
      exactKeys(source, ['contract', 'owners'], 'entity ownership metadata')
      const owners = record(source.owners, 'entity ownership metadata.owners')
      if (source.contract !== 'cordisx.entity-directory-owners/v1' || Object.keys(owners).length > MAX_ENTITIES) {
        throw new Error('entity ownership metadata is invalid')
      }
      const validated: Record<string, EntityOwnerScope> = {}
      for (const [agentId, candidate] of Object.entries(owners)) {
        if (!ENTITY_ID.test(agentId)) throw new Error('entity ownership agentId is invalid')
        const owner = record(candidate, `entity ownership metadata.owners.${agentId}`)
        exactKeys(owner, ['profileId', 'installationId', 'pluginId'], `entity ownership metadata.owners.${agentId}`)
        if (
          owner.profileId !== this.#profileId || typeof owner.installationId !== 'string'
          || typeof owner.pluginId !== 'string'
        ) throw new Error('entity ownership scope is invalid')
        validated[agentId] = {
          profileId: this.#profileId,
          installationId: opaqueId(owner.installationId, 'installationId'),
          pluginId: localId(owner.pluginId, 'pluginId'),
        }
      }
      return validated
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  private async writeOwners(owners: Readonly<Record<string, EntityOwnerScope>>): Promise<void> {
    const temporary = `${this.#ownersFile}.tmp-${process.pid}-${randomUUID()}`
    await syncedWrite(
      temporary,
      `${JSON.stringify({ contract: 'cordisx.entity-directory-owners/v1', owners }, null, 2)}\n`,
    )
    await rename(temporary, this.#ownersFile)
  }
  private async readTree(
    agentId: string,
  ): Promise<{ readonly entityText: string; readonly prompts: readonly EntityPromptFile[] }> {
    await this.ensureRoot()
    const directory = this.entityDirectory(agentId)
    const directoryMetadata = await lstat(directory)
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new Error('symlink-escape')
    const canonical = `${await realpath(directory)}${path.sep}`
    const entityPath = path.join(directory, 'entity.json')
    const entityReal = await realpath(entityPath)
    const entityMetadata = await lstat(entityReal)
    if (!entityReal.startsWith(canonical) || !entityMetadata.isFile() || entityMetadata.isSymbolicLink()) {
      throw new Error('symlink-escape')
    }
    const entityText = await readUtf8(entityReal)
    const entity = parseEntityFile(entityText)
    const prompts = await Promise.all(
      referencedPromptPaths(entity).map(async promptPath => {
        const candidate = path.resolve(directory, promptPath.slice(2))
        const resolved = await realpath(candidate)
        const metadata = await lstat(resolved)
        if (!resolved.startsWith(canonical) || !metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error('symlink-escape')
        }
        return { path: promptPath, text: await readUtf8(resolved) }
      }),
    )
    return { entityText, prompts }
  }
  private async publishTree(
    agentId: string,
    entityText: string,
    promptFiles: readonly EntityPromptFile[],
    replace: boolean,
  ): Promise<void> {
    await this.ensureRoot()
    const target = this.entityDirectory(agentId)
    if (replace) {
      const metadata = await lstat(target)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('symlink-escape')
    }
    const candidate = path.join(this.#root, `.candidate-${agentId}-${process.pid}-${randomUUID()}`)
    const backup = path.join(this.#root, `.previous-${agentId}-${process.pid}-${randomUUID()}`)
    await mkdir(candidate, { mode: 0o700 })
    try {
      await syncedWrite(path.join(candidate, 'entity.json'), entityText)
      for (const file of promptFiles) {
        const destination = path.join(candidate, file.path.slice(2))
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
        await syncedWrite(destination, file.text)
      }
      this.validateSource(entityText, promptFiles, agentId)
      if (replace) await rename(target, backup)
      try {
        await rename(candidate, target)
      } catch (error) {
        if (replace) await rename(backup, target).catch(() => undefined)
        throw error
      }
      if (replace) await rm(backup, { recursive: true, force: true })
    } finally {
      await rm(candidate, { recursive: true, force: true })
      await rm(backup, { recursive: true, force: true })
    }
  }
  private async refresh(): Promise<void> {
    const owners = await this.readOwners()
    const names: string[] = await readdir(this.#root).catch(() => [] as string[])
    const next = new Map<string, RegistryState>()
    for (const [agentId, owner] of Object.entries(owners)) {
      if (!names.includes(agentId)) continue
      try {
        const tree = await this.readTree(agentId)
        const source = this.validateSource(tree.entityText, tree.prompts, agentId)
        const declaration = this.#declarations.get(ownerKey(owner))?.get(agentId)
        const origin = declaration?.digest === source.digest ? 'materialized-template' : 'local'
        next.set(agentId, { record: this.entityRecord(owner, source.resolution, origin) })
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        const invalid = message.includes('symlink')
          ? 'symlink-escape'
          : message.includes('missing prompt') || (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing-prompt-file'
          : message.includes('entity')
          ? 'invalid-entity'
          : 'io-error'
        next.set(agentId, { invalid })
      }
    }
    const ids = new Set([...this.#states.keys(), ...next.keys()])
    for (const id of ids) {
      const before = this.#states.get(id)
      const after = next.get(id)
      const owner = owners[id] ?? before?.record?.owner
      if (owner === undefined) continue
      if (after?.record !== undefined && before?.record === undefined) {
        this.#changes.push({ kind: 'entity-added', sequence: ++this.#revision, entity: after.record })
      } else if (
        after?.record !== undefined && before?.record !== undefined && after.record.digest !== before.record.digest
      ) this.#changes.push({ kind: 'entity-updated', sequence: ++this.#revision, entity: after.record })
      else if (after === undefined && before?.record !== undefined) {
        this.#changes.push({
          kind: 'entity-removed',
          sequence: ++this.#revision,
          identity: before.record.identity,
          owner,
        })
      } else if (after?.invalid !== undefined && after.invalid !== before?.invalid) {
        this.#changes.push({
          kind: 'entity-invalidated',
          sequence: ++this.#revision,
          agentId: id,
          owner,
          code: after.invalid,
        })
      }
    }
    this.#states.clear()
    for (const [id, state] of next) this.#states.set(id, state)
  }
}
