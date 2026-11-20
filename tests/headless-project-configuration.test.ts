import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { CodexChatConfiguration } from '../packages/cli/src/launcher/codex-chat-configuration.js'
import { HeadlessProjectCatalog } from '../packages/cli/src/launcher/headless-project-catalog.js'

describe('headless workspace projects', () => {
  it('lists only repository roots contained in the explicitly configured workspace', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cx-workspace-')))
    try {
      const workspace = path.join(root, 'workspace'), repo = path.join(workspace, 'repo')
      const outside = path.join(root, 'outside')
      await mkdir(repo, { recursive: true })
      await mkdir(outside)
      await mkdir(path.join(repo, '.git'))
      await mkdir(path.join(outside, '.git'))
      await mkdir(path.join(workspace, 'plain'))
      await symlink(outside, path.join(workspace, 'outside-link'))
      await expect(HeadlessProjectCatalog.open(path.parse(workspace).root)).rejects.toThrow(
        'HEADLESS_WORKSPACE_INVALID',
      )
      const projects = await HeadlessProjectCatalog.open(workspace)
      const list = await projects.projects()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ name: 'repo', cwd: repo, roots: [repo] })
      await expect(projects.project(list[0]!.projectId, outside)).rejects.toThrow('CWD_OUTSIDE_PROJECT')
      await expect(projects.project('unknown')).rejects.toThrow('PROJECT_UNAVAILABLE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('switches an idle service chat and preserves project and transport roots on later turns', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cx-headless-project-')))
    const workspace = path.join(root, 'workspace'), project = path.join(workspace, 'repo')
    const mailbox = path.join(root, 'transport'), configPath = path.join(root, 'config.json')
    await mkdir(project, { recursive: true })
    await mkdir(mailbox)
    await writeFile(path.join(project, '.git'), 'gitdir: /test/worktree\n')
    await ensureHomeConfig(configPath)
    const preferences = await ChatExecutionPreferences.open({
      file: path.join(root, 'execution.json'),
      configPath,
      appId: 'codex',
      profileId: 'default',
    })
    let configuration!: CodexChatConfiguration
    let actual: Record<string, unknown> = {
      id: 'thread',
      status: { type: 'idle' },
      cwd: root,
      model: 'model',
      modelProvider: 'openai',
      sandbox: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false },
    }
    const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === 'thread/read') return { thread: { ...actual } }
      if (method === 'thread/settings/update') {
        actual = { ...actual, ...params, sandbox: params.sandboxPolicy }
        await configuration.observe('thread', actual)
        return {}
      }
      throw new Error(`unexpected ${method}`)
    }
    try {
      const projects = await HeadlessProjectCatalog.open(workspace)
      configuration = await CodexChatConfiguration.open({
        preferences,
        file: path.join(root, 'configuration.json'),
        request,
        headlessProjects: projects,
        sandboxAuxiliaryRoot: mailbox,
      })
      const [{ projectId }] = await configuration.projects()
      expect(projectId).toBeDefined()
      const result = await configuration.applyChannel('project-set', {
        sessionId: 'thread',
        projectId,
        expectedRevision: 0,
      }, async () => true)
      expect(result).toMatchObject({ status: 'applied', application: 'applied' })
      expect(actual.cwd).toBe(project)
      expect(actual.sandbox).toMatchObject({
        type: 'workspaceWrite',
        writableRoots: [project, mailbox],
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      })
      expect(await configuration.call('project', { sessionId: 'thread' })).toMatchObject({
        status: 'ok',
        effective: { projectId, cwd: project },
      })
      const prepared = await configuration.prepare('turn/start', { threadId: 'thread' })
      const final = await (configuration as unknown as { finalize(method: string, params: object): Promise<object> })
        .finalize('turn/start', prepared)
      expect(final).toMatchObject({ cwd: project, sandboxPolicy: { writableRoots: [project, mailbox] } })
      await rm(path.join(project, '.git'))
      await expect(configuration.prepare('turn/start', { threadId: 'thread' })).rejects.toThrow('PROJECT_UNAVAILABLE')
    } finally {
      await configuration?.close()
      await preferences.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
