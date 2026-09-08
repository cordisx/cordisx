import type { HostExecutionProject, HostExecutionProjectsResult } from '@cordisx/protocol/entity-execution-context/v1'

export interface NativeExecutionProjectAuthority {
  readonly projectlessSupported: boolean
  list(): Promise<HostExecutionProjectsResult>
  read(projectId: string): Promise<HostExecutionProject | undefined>
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
function project(value: unknown): HostExecutionProject | undefined {
  const raw = object(value)
  if (!raw || !id(raw.id) || typeof raw.name !== 'string' || !Array.isArray(raw.roots) || raw.roots.length > 64) {
    return undefined
  }
  const roots = raw.roots.map(root => object(root)?.path)
  if (roots.some(root => typeof root !== 'string' || !root.startsWith('/') || root.includes('\0'))) return undefined
  return Object.freeze({ id: raw.id, name: raw.name, roots: Object.freeze(roots as string[]) })
}

/** Uses only the already connected Desktop app-server's audited project methods. */
export function nativeExecutionProjects(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): NativeExecutionProjectAuthority {
  return {
    projectlessSupported: true,
    async read(projectId) {
      if (!id(projectId)) return undefined
      try {
        const result = project(object(await request('project/read', { projectId }))?.project)
        return result?.id === projectId ? result : undefined
      } catch {
        return undefined
      }
    },
    async list() {
      const projects: HostExecutionProject[] = []
      const seen = new Set<string>()
      let cursor: string | null = null
      try {
        for (let page = 0; page < 64; page++) {
          const result = object(await request('project/list', { cursor, limit: 100 }))
          if (!Array.isArray(result?.data)) throw new Error('Invalid native project list')
          for (const value of result.data) {
            const parsed = project(value)
            if (!parsed || seen.has(parsed.id)) throw new Error('Ambiguous native project list')
            seen.add(parsed.id)
            projects.push(parsed)
          }
          const next = result.nextCursor
          if (next === undefined || next === null) return { status: 'available', projects }
          if (!id(next) || next === cursor) throw new Error('Invalid native project cursor')
          cursor = next
        }
      } catch { /* unavailable is not an empty or fabricated project catalog */ }
      return { status: 'unavailable', code: 'host-unavailable' }
    },
  }
}
