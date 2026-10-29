import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createNativeAgentModelsHandler,
  type NativeAgentModelsAuthority,
  NativeAgentModelSelectionRejected,
  startNativeAgentModelsServer,
} from '../packages/cli/src/launcher/native-agent-models.js'

function fixture() {
  const authority = {
    catalog: vi.fn(async () => [{
      providerId: 'configured',
      pluginId: 'host',
      title: 'Configured provider',
      endpoint: 'https://private.invalid',
      secret: 'never-project',
      models: [{ id: 'shared-model', label: 'Shared model', aliases: [] }],
    }]),
    controller: {
      prepareThreadResume: vi.fn(async () => ({
        kind: 'resume' as const,
        resumeToken: 'private-lease-token',
        configOverrides: { credential: 'never-project' },
      })),
      completeThreadResume: vi.fn(async () => true),
    },
    switchThread: vi.fn(async (_input: unknown) => {}),
    reserve: vi.fn(() => true),
    commit: vi.fn(),
    release: vi.fn(),
  } satisfies NativeAgentModelsAuthority
  return { authority, handler: createNativeAgentModelsHandler(authority) }
}
const target = { threadId: 'target-thread', providerId: 'configured', model: 'shared-model' }

describe('Agent model-provider tools', () => {
  it('projects only model identifiers and labels from the same admitted provider catalog', async () => {
    const f = fixture()
    expect(await f.handler('list', {})).toEqual({
      threadCreation: { status: 'unavailable', reason: 'native-task-provider-creation-unavailable' },
      providers: [{
        providerId: 'configured',
        title: 'Configured provider',
        models: [{ id: 'shared-model', label: 'Shared model' }],
      }],
    })
    expect(f.authority.controller.prepareThreadResume).not.toHaveBeenCalled()
  })
  it('discloses catalog reasoning choices without endpoint or credential metadata', async () => {
    const f = fixture()
    f.authority.catalog.mockResolvedValueOnce([{
      providerId: 'configured',
      pluginId: 'host',
      title: 'Configured provider',
      endpoint: 'https://private.invalid',
      secret: 'never-project',
      models: [{
        id: 'shared-model',
        label: 'Shared model',
        aliases: [],
        reasoningCapabilities: { efforts: ['low', 'high'], defaultEffort: 'high' },
      }],
    }] as any)
    const result = await f.handler('list', {})
    expect(result).toMatchObject({
      providers: [{ models: [{ reasoningCapabilities: { efforts: ['low', 'high'], defaultEffort: 'high' } }] }],
    })
    expect(JSON.stringify(result)).not.toMatch(/never-project|private.invalid|endpoint|secret/)
    expect(f.authority.reserve).not.toHaveBeenCalled()
    f.authority.catalog.mockResolvedValueOnce(
      [{
        providerId: 'configured',
        pluginId: 'host',
        models: [{
          id: 'shared-model',
          label: 'Shared model',
          aliases: [],
          reasoningCapabilities: { efforts: ['low'], secret: 'never-project' },
        }],
      }] as any,
    )
    const malformed = await f.handler('list', {})
    expect(JSON.stringify(malformed)).not.toMatch(/never-project|reasoningCapabilities/)
  })
  it('rejects unsupported task creation without preparing credentials or mutating a conversation', async () => {
    const f = fixture()
    expect(
      await f.handler('create', {
        providerId: 'configured',
        model: 'shared-model',
        prompt: 'First user message',
        target: { type: 'projectless' },
      }),
    ).toEqual({ status: 'rejected', reason: 'invalid-selection' })
    expect(f.authority.controller.prepareThreadResume).not.toHaveBeenCalled()
    expect(f.authority.switchThread).not.toHaveBeenCalled()
    expect(f.authority.reserve).not.toHaveBeenCalled()
    expect(f.authority.commit).not.toHaveBeenCalled()
  })
  it('rejects unknown provider/model pairs and connection injection before acquiring credentials', async () => {
    const f = fixture()
    for (
      const input of [
        { ...target, providerId: 'unknown' },
        { ...target, model: 'unknown' },
        { ...target, config: { endpoint: 'https://other.invalid' } },
        { ...target, threadId: 'bad\nthread' },
      ]
    ) expect(await f.handler('select', input)).toMatchObject({ status: 'rejected' })
    expect(f.authority.controller.prepareThreadResume).not.toHaveBeenCalled()
    expect(f.authority.switchThread).not.toHaveBeenCalled()
  })
  it('commits the target-specific lease and renderer projection only after native acknowledgement', async () => {
    const f = fixture()
    const result = await f.handler('select', target)
    expect(result).toEqual({ status: 'selected', ...target })
    expect(JSON.stringify(result)).not.toMatch(/private-lease-token|never-project|credential/)
    expect(f.authority.switchThread).toHaveBeenCalledWith({
      ...target,
      configOverrides: { credential: 'never-project' },
    })
    expect(f.authority.controller.completeThreadResume).toHaveBeenCalledWith({
      threadId: target.threadId,
      resumeToken: 'private-lease-token',
      succeeded: true,
    })
    expect(f.authority.commit).toHaveBeenCalledWith(target)
    expect(f.authority.release).toHaveBeenCalledWith(target.threadId)
  })
  it('retains an honest uncertain result after a lost native acknowledgement without retrying', async () => {
    const f = fixture()
    f.authority.switchThread.mockRejectedValue(new Error('private endpoint and key must never escape'))
    expect(await f.handler('select', target)).toEqual({
      status: 'reconciliation-required',
      reason: 'native-selection-unavailable',
    })
    expect(f.authority.controller.completeThreadResume).toHaveBeenCalledWith({
      threadId: target.threadId,
      resumeToken: 'private-lease-token',
      succeeded: false,
    })
    expect(f.authority.switchThread).toHaveBeenCalledTimes(1)
    expect(f.authority.commit).not.toHaveBeenCalled()
    expect(f.authority.release).toHaveBeenCalledWith(target.threadId)
  })
  it('refuses a pending UI selection without preparing or changing the native thread', async () => {
    const f = fixture()
    f.authority.reserve.mockReturnValue(false)
    expect(await f.handler('select', target)).toMatchObject({ status: 'rejected', reason: 'selection-busy' })
    expect(f.authority.controller.prepareThreadResume).not.toHaveBeenCalled()
  })
  it('distinguishes a known pre-mutation busy rejection from an uncertain native result', async () => {
    const f = fixture()
    f.authority.switchThread.mockRejectedValue(new NativeAgentModelSelectionRejected('not idle'))
    expect(await f.handler('select', target)).toEqual({ status: 'rejected', reason: 'thread-not-idle' })
    expect(f.authority.commit).not.toHaveBeenCalled()
  })
  it('serves the actual stdio MCP subprocess over an authenticated ephemeral binding and removes it on close', async () => {
    const f = fixture()
    const server = await startNativeAgentModelsServer()
    server.bind(f.authority)
    const binding = JSON.parse(await readFile(server.bindingPath, 'utf8'))
    expect((await stat(server.bindingPath)).mode & 0o777).toBe(0o600)
    const child = spawn(process.execPath, [
      path.resolve('packages/cli/assets/launcher/native-agent-models-mcp.mjs'),
      server.bindingPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = '', stderr = ''
    const responses = new Map<number, any>()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.stdout.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        responses.set(message.id, message)
      }
    })
    async function request(id: number, method: string, params: unknown) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      await vi.waitFor(() => expect(responses.has(id), stderr).toBe(true))
      return responses.get(id).result
    }
    try {
      expect((await request(1, 'initialize', { protocolVersion: '2024-11-05' })).capabilities).toEqual({ tools: {} })
      const advertised = (await request(2, 'tools/list', {})).tools
      expect(advertised.map((tool: any) => tool.name)).toEqual([
        'list_model_providers',
        'select_thread_model_provider',
        'create_thread_with_provider',
      ])
      expect(advertised[0].description).toContain('only when threadCreation is available')
      const catalog = await request(3, 'tools/call', { name: 'list_model_providers' })
      expect(catalog.isError).toBe(false)
      expect(JSON.parse(catalog.content[0].text).threadCreation).toEqual({
        status: 'unavailable',
        reason: 'native-task-provider-creation-unavailable',
      })
      expect(catalog.content[0].text).not.toMatch(/never-project|private.invalid/)
      const selected = await request(4, 'tools/call', { name: 'select_thread_model_provider', arguments: target })
      expect(JSON.parse(selected.content[0].text)).toEqual({ status: 'selected', ...target })
      await new Promise<void>((resolve, reject) => {
        const socket = connect(
          binding.socketPath,
          () => socket.write(JSON.stringify({ token: 'wrong', operation: 'list' }) + '\n'),
        )
        socket.on('data', data => {
          expect(JSON.parse(data.toString()).ok).toBe(false)
          socket.end()
          resolve()
        })
        socket.on('error', reject)
      })
      expect(stderr).toBe('')
      const taskAuthority: NativeAgentModelsAuthority = f.authority
      taskAuthority.createTask = vi.fn(async (_input: unknown, metadata: unknown) => ({ status: 'pending', metadata }))
      const created = await request(5, 'tools/call', {
        name: 'create_thread_with_provider',
        arguments: { operationId: 'same-op' },
        _meta: { 'openai/toolCallId': 'real-call', 'openai/threadId': 'source' },
      })
      expect(JSON.parse(created.content[0].text)).toMatchObject({
        status: 'pending',
        metadata: { 'openai/toolCallId': 'real-call' },
      })
    } finally {
      child.stdin.end()
      if (child.exitCode === null) await once(child, 'exit')
      await server.close()
    }
    await expect(readFile(server.bindingPath)).rejects.toThrow()
  })
})
