import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'
import type { AgentTaskContext, AgentTaskResolvedContext } from '@cordisx/protocol/agent-task/v1'
import type {
  EntityExecutionBinding,
  EntityExecutionBindingResult,
  EntityExecutionBindingWriteResult,
  EntityExecutionContextResult,
  EntityExecutionContexts,
  HostExecutionProject,
} from '@cordisx/protocol/entity-execution-context/v1'
import type { NativeExecutionProjectAuthority } from './native-execution-projects.js'

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const identity = (value: unknown): value is AgentDefinitionIdentity =>
  object(value)
  && Object.keys(value).every(key => ['agentId', 'revision'].includes(key)) && text(value.agentId, 128)
  && text(value.revision)
const binding = (value: unknown): value is EntityExecutionBinding =>
  object(value) && (value.kind === 'projectless'
    ? Object.keys(value).every(key => key === 'kind')
    : value.kind === 'project' && text(value.projectId) && Object.keys(value).every(key =>
      ['kind', 'projectId', 'cwd'].includes(key)
    )
      && (value.cwd === undefined || text(value.cwd, 4096) && value.cwd.startsWith('/') && !value.cwd.includes('\0')))
const unavailable = <Code extends 'invalid-input' | 'host-unavailable' | 'unsupported' | 'project-unavailable'>(
  code: Code,
) => ({ status: 'unavailable' as const, code })

/** Host-owned wrapper keeps the signed Entity RPC and native project authority out of plugin inputs. */
export function createEntityExecutionContexts(input: {
  readonly active: () => boolean
  readonly request: (operation: string, value: object) => Promise<unknown>
  readonly projects?: NativeExecutionProjectAuthority
  readonly resolveProject: (context: AgentTaskContext, project: HostExecutionProject) => Promise<
    { readonly status: 'resolved'; readonly context: AgentTaskResolvedContext } | {
      readonly status: 'unavailable'
      readonly code: string
    }
  >
}): EntityExecutionContexts {
  const call = async (operation: string, value: object): Promise<unknown> => {
    if (!input.active()) return unavailable('host-unavailable')
    try {
      const result = await input.request(operation, structuredClone(value))
      return input.active() ? structuredClone(result) : unavailable('host-unavailable')
    } catch {
      return unavailable('host-unavailable')
    }
  }
  const validateProject = async (value: Extract<EntityExecutionBinding, { kind: 'project' }>) => {
    const project = await input.projects?.read(value.projectId)
    if (!project || !input.active()) return undefined
    const result = await input.resolveProject({ ...value }, project)
    return result.status === 'resolved' && result.context.projectId === value.projectId && input.active()
      ? result.context
      : undefined
  }
  return {
    async get(value) {
      if (!identity(value)) return unavailable('invalid-input')
      return await call('get', { identity: value }) as EntityExecutionBindingResult
    },
    async set(value) {
      if (
        !object(value) || !identity(value.identity) || !text(value.mutationId)
        || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !binding(value.binding)
        || !Object.keys(value).every(key => ['identity', 'mutationId', 'expectedRevision', 'binding'].includes(key))
      ) return unavailable('invalid-input')
      if (!input.active()) return unavailable('host-unavailable')
      if (value.binding.kind === 'project' && await validateProject(value.binding) === undefined) {
        return unavailable('project-unavailable')
      }
      return await call('set', { contextRequest: value }) as EntityExecutionBindingWriteResult
    },
    async resolve(value) {
      if (
        !object(value) || !identity(value.identity) || !text(value.operationId)
        || !Object.keys(value).every(key => ['identity', 'operationId'].includes(key))
      ) return unavailable('invalid-input')
      if (!input.projects?.projectlessSupported) return unavailable('unsupported')
      const result = await call('resolve', value) as EntityExecutionContextResult
      if (result.status !== 'resolved') return result
      if (!binding(result.binding)) return unavailable('host-unavailable')
      if (result.binding.kind === 'project') {
        const resolved = await validateProject(result.binding)
        if (!resolved) return unavailable('project-unavailable')
        return {
          status: 'resolved',
          binding: result.binding,
          context: { kind: 'project', projectId: result.binding.projectId, cwd: resolved.cwd },
        }
      }
      return result.context.kind === 'directory' && text(result.context.cwd, 4096)
        ? result
        : unavailable('host-unavailable')
    },
    async projects() {
      if (!input.active()) return unavailable('host-unavailable')
      if (!input.projects) return unavailable('unsupported')
      const result = await input.projects.list()
      return input.active() ? result : unavailable('host-unavailable')
    },
  }
}
