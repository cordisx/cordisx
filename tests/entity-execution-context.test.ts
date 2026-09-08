import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EntityRecord } from '@cordisx/protocol/entities/v1'
import { EntityExecutionContextDirectory } from '../packages/cli/src/launcher/entity-execution-context.js'
import { resolveAgentTaskContext, resolveNativeProjectRoots } from '../packages/cli/src/launcher/agent-task-context.js'
import { createEntityExecutionContexts } from '../packages/cli/src/renderer/entity-execution-contexts.js'
import { nativeExecutionProjects } from '../packages/cli/src/renderer/native-execution-projects.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function home() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'entity-context-'))
  roots.push(root)
  return root
}
const entity: EntityRecord = {
  owner: { profileId: 'test', installationId: 'test-install', pluginId: 'context-test' },
  identity: { agentId: 'leader', revision: 'exact' },
  digest: 'sha256:fixture',
  access: 'owned',
  origin: 'local',
  definition: {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId: 'leader', revision: 'exact' },
    extends: [],
    inherit: {
      promptSections: 'append',
      rules: 'append',
      skills: 'append',
      tools: 'merge',
      mcpServers: 'merge',
      runtimeDefaults: 'merge',
    },
  },
}

describe('owned Entity execution contexts', () => {
  it('resolves the explicit projectless default into a stable private operation workspace, never the Host cwd', async () => {
    const root = await home()
    const contexts = new EntityExecutionContextDirectory(root, 'test')
    expect(await contexts.get(entity)).toEqual({ status: 'available', revision: 0, binding: { kind: 'projectless' } })
    const one = await contexts.resolve(entity, 'first', () => true)
    const replay = await contexts.resolve(entity, 'first', () => true)
    expect(one).toEqual(replay)
    expect(one).toMatchObject({ status: 'resolved', binding: { kind: 'projectless' }, context: { kind: 'directory' } })
    if (one.status !== 'resolved' || one.context.kind !== 'directory') throw new Error('not resolved')
    expect(one.context.cwd).not.toBe(process.cwd())
    expect(one.context.cwd).toContain('/workspaces/projectless/')
    expect(one.context).not.toHaveProperty('projectId')
    expect(await contexts.resolve(entity, 'second', () => true)).not.toEqual(one)
  })

  it('CAS-updates real defaults without changing Entity identity and scopes replay across owners', async () => {
    const contexts = new EntityExecutionContextDirectory(await home(), 'test')
    const request = {
      identity: entity.identity,
      expectedRevision: 0,
      mutationId: 'bind',
      binding: { kind: 'project' as const, projectId: 'native-project' },
    }
    expect(await contexts.set(entity, request, () => true)).toMatchObject({ status: 'applied', revision: 1 })
    expect(await contexts.set(entity, request, () => true)).toMatchObject({ disposition: 'replayed', revision: 1 })
    expect(await contexts.set(entity, { ...request, binding: { kind: 'projectless' } }, () => true)).toMatchObject({
      code: 'operation-conflict',
    })
    expect(await contexts.set(entity, { ...request, mutationId: 'second' }, () => true)).toEqual({
      status: 'conflict',
      currentRevision: 1,
    })
    expect(await contexts.get({ ...entity, identity: { ...entity.identity, revision: 'next' } })).toMatchObject({
      binding: request.binding,
    })
    expect(await contexts.get({ ...entity, owner: { ...entity.owner, installationId: 'other' } })).toMatchObject({
      revision: 0,
      binding: { kind: 'projectless' },
    })
    expect(await contexts.set(entity, { ...request, expectedRevision: 1, mutationId: 'stale' }, () => false))
      .toMatchObject({ status: 'unavailable' })
  })

  it('rejects a symlink replacing an owned workspace on replay', async () => {
    const contexts = new EntityExecutionContextDirectory(await home(), 'test')
    const result = await contexts.resolve(entity, 'first', () => true)
    if (result.status !== 'resolved' || result.context.kind !== 'directory') throw new Error('not resolved')
    const outside = await home()
    await rm(result.context.cwd, { recursive: true })
    await symlink(outside, result.context.cwd)
    expect(await contexts.resolve(entity, 'first', () => true)).toMatchObject({ status: 'unavailable' })
    expect(await readdir(outside)).toEqual([])
  })

  it('validates canonical directory membership for the actual project, including symlink escape', async () => {
    const root = await home()
    const child = path.join(root, 'child')
    await mkdir(child)
    const outside = await home()
    await symlink(outside, path.join(root, 'escape'))
    const project = { id: 'native-id', roots: [root] }
    const resolve = (cwd?: string) =>
      resolveAgentTaskContext({ kind: 'project', projectId: project.id, ...(cwd === undefined ? {} : { cwd }) }, {
        inherited: async () => undefined,
        project: (id, directory) => resolveNativeProjectRoots(project, id, directory),
      })
    expect(await resolve()).toMatchObject({ status: 'resolved', context: { projectId: project.id } })
    expect(await resolve(child)).toMatchObject({ status: 'resolved' })
    expect(await resolve(path.join(root, 'escape'))).toEqual({ status: 'unavailable', code: 'project-unavailable' })
    expect(await resolve(outside)).toEqual({ status: 'unavailable', code: 'project-unavailable' })
  })

  it('uses project/list and project/read without fabricating projects or accepting mismatched IDs', async () => {
    const calls: unknown[] = []
    const actual = { id: 'real', name: 'Project', roots: [{ path: '/actual' }] }
    const port = nativeExecutionProjects(async (method, params) => {
      calls.push([method, params])
      return method === 'project/list' ? { data: [actual], nextCursor: null } : { project: actual }
    })
    expect(await port.list()).toEqual({
      status: 'available',
      projects: [{ id: 'real', name: 'Project', roots: ['/actual'] }],
    })
    expect(await port.read('foreign')).toBeUndefined()
    expect(calls).toEqual([['project/list', { cursor: null, limit: 100 }], ['project/read', { projectId: 'foreign' }]])
  })

  it('checks native projects before binding writes and retires delayed calls with their owner', async () => {
    let active = true
    const calls: string[] = []
    const service = createEntityExecutionContexts({
      active: () => active,
      request: async operation => {
        calls.push(operation)
        return { status: 'available', revision: 0, binding: { kind: 'projectless' } }
      },
      projects: {
        projectlessSupported: true,
        read: async () => undefined,
        list: async () => ({ status: 'available', projects: [] }),
      },
      resolveProject: async () => ({ status: 'unavailable', code: 'project-unavailable' }),
    })
    expect(
      await service.set({
        identity: entity.identity,
        expectedRevision: 0,
        mutationId: 'bind',
        binding: { kind: 'project', projectId: 'unknown' },
      }),
    ).toEqual({ status: 'unavailable', code: 'project-unavailable' })
    expect(calls).toEqual([])
    active = false
    expect(await service.get(entity.identity)).toEqual({ status: 'unavailable', code: 'host-unavailable' })
    expect(calls).toEqual([])
  })
})
