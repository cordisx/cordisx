import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AgentTaskContext, AgentTaskFailureCode, AgentTaskResolvedContext } from '@cordisx/protocol/agent-task/v1'

export type TaskContextResolution =
  | { readonly status: 'resolved'; readonly context: AgentTaskResolvedContext }
  | { readonly status: 'unavailable'; readonly code: AgentTaskFailureCode }

/** Filesystem checks live in the launcher, never in plugin renderer assertions. */
export async function resolveAgentTaskContext(
  input: AgentTaskContext,
  dependencies: {
    readonly inherited: (sessionId: string) => Promise<AgentTaskResolvedContext | undefined>
    /** Audited native project authority; absent until the installed adapter can prove membership. */
    readonly project?: (projectId: string, cwd?: string) => Promise<AgentTaskResolvedContext | undefined>
  },
): Promise<TaskContextResolution> {
  const fail = (code: AgentTaskFailureCode): TaskContextResolution => ({ status: 'unavailable', code })
  if (input === undefined || input === null) return fail('context-required')
  if (typeof input !== 'object' || Array.isArray(input)) return fail('invalid-input')
  const exact = (keys: string[]): boolean => Object.keys(input).every(key => keys.includes(key))
  let selected: AgentTaskResolvedContext | undefined
  let failure: AgentTaskFailureCode = 'directory-unavailable'
  try {
    if (input.kind === 'directory') {
      if (!exact(['kind', 'cwd'])) return fail('invalid-input')
      selected = { cwd: input.cwd }
    } else if (input.kind === 'inherit') {
      if (!exact(['kind', 'sessionId']) || typeof input.sessionId !== 'string' || !input.sessionId.length) {
        return fail('invalid-input')
      }
      failure = 'context-unavailable'
      selected = await dependencies.inherited(input.sessionId)
    } else if (input.kind === 'project') {
      if (!exact(['kind', 'projectId', 'cwd']) || typeof input.projectId !== 'string' || !input.projectId.length) {
        return fail('invalid-input')
      }
      failure = 'project-unavailable'
      selected = await dependencies.project?.(input.projectId, input.cwd)
      if (selected?.projectId !== input.projectId) return fail(failure)
    } else return fail('invalid-input')
    if (selected === undefined) return fail(failure)
    if (typeof selected.cwd !== 'string' || !isAbsolute(selected.cwd) || selected.cwd.includes('\0')) {
      return fail(failure)
    }
    const cwd = await realpath(selected.cwd)
    if (!(await stat(cwd)).isDirectory()) return fail(failure)
    await access(cwd, constants.R_OK | constants.X_OK)
    return {
      status: 'resolved',
      context: { cwd, ...(selected.projectId === undefined ? {} : { projectId: selected.projectId }) },
    }
  } catch {
    return fail(failure)
  }
}
