import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1,
  type BoundAgentLoopClient,
} from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'

describe('AgentLoop renderer injection', () => {
  it('drives text create/send and proactive assistant, approval, and lifecycle events through ctx.agentLoop', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'tests/fixtures/agent-loop-runtime-plugin.ts')
    const base = await loadConfig(path.join(root, 'cordisx.config.example.json'))
    const config = {
      ...base,
      providers: [{
        id: 'gateway-a', kind: 'cli-proxy-api' as const, displayName: 'Gateway A', baseUrl: 'https://gateway-a.test/v1',
        apiKeyEnv: 'GATEWAY_A_KEY', codexExecutable: 'codex', codexHome: '/tmp/cordisx-agent-loop-gateway', enabled: true, timeoutMs: 1_000,
      }],
      plugins: [{ id: 'agent-loop-runtime', entry, enabled: true, config: {} }],
    }
    const identity = { source: pathToFileURL(entry).href, id: 'agent-loop-runtime' }
    const policies = (['tasks.create', 'tasks.content.read', 'turns.submit'] as const).map(capability => createPermissionPolicyRecord({
      profileId: 'agent-loop-test', identity, capability, scope: { providers: ['gateway-a'] }, policy: 'allow',
    }))
    const token = 'agent-loop-provider-token'
    const permissionToken = 'agent-loop-permission-token'
    const bundle = await buildRendererBundle(config, {
      providerBridgeToken: token,
      generation: 'agent-loop-runtime-test',
      permission: { profileId: 'agent-loop-test', policies, bridgeToken: permissionToken },
    })
    const dom = new JSDOM('<html lang="en"><head></head><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>', {
      runScripts: 'dangerously', url: 'https://codex.local/',
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'structuredClone', { value: globalThis.structuredClone })
    Object.defineProperty(dom.window, '__cordisxPermissionPolicyRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; token: string; records: readonly unknown[] }
        expect(request.token).toBe(permissionToken)
        queueMicrotask(() => (dom.window as unknown as { __cordisxPermissionPolicyReceiveV1?: (response: string) => void })
          .__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value: request.records })))
      },
    })
    const requests: { operation: string; input: Record<string, unknown> }[] = []
    let turnStarted = false
    Object.defineProperty(dom.window, '__cordisxProviderRequestV1', {
      configurable: true,
      value: (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; token: string; operation: string; input: Record<string, unknown> }
        expect(request.token).toBe(token)
        requests.push({ operation: request.operation, input: request.input })
        let value: unknown
        if (request.operation === 'status') {
          value = {
            hostId: 'cordisx-provider-fleet', hostName: 'CordisX External Provider Fleet', mode: 'read-write',
            supportedCapabilities: ['models.read', 'tasks.catalog.read', 'tasks.content.read', 'tasks.create', 'tasks.control', 'turns.submit', 'turns.control'],
            diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
          }
        } else if (request.operation === 'availability') {
          value = [{ providerId: 'gateway-a', displayName: 'Gateway A', generation: 'gateway-generation-1', state: 'ready' }]
        } else if (request.operation === 'models.list') {
          value = { ok: true, value: {
            contract: 'cordisx.platform-model-page/v1', schemaVersion: 1, providerIds: ['gateway-a'],
            models: [{ contract: 'cordisx.platform-model/v1', schemaVersion: 1, ref: { providerId: 'gateway-a', modelId: 'model-1' }, hostId: 'cli-proxy-api:gateway-a', label: 'Model 1', isDefault: true }],
          } }
        } else if (request.operation === 'agent-loop.create') {
          value = { ok: true, value: {
            contract: 'cordisx.platform-session/v1', schemaVersion: 1, ref: { providerId: 'gateway-a', remoteSessionId: 'session-1' },
            hostId: 'cli-proxy-api:gateway-a', model: { providerId: 'gateway-a', modelId: 'model-1' }, cwd: root, state: 'active',
          } }
        } else if (request.operation === 'turns.submit') {
          turnStarted = true
          value = { ok: true, value: { contract: 'cordisx.platform-turn-start/v1', schemaVersion: 1, session: { providerId: 'gateway-a', remoteSessionId: 'session-1' }, turnId: 'turn-1' } }
        } else if (request.operation === 'agent-loop.lifecycle.read') {
          const afterSequence = request.input.afterSequence as number
          const events = turnStarted ? [
            { sequence: 1, session: { providerId: 'gateway-a', remoteSessionId: 'session-1' }, turnId: 'turn-1', type: 'approval.required', approval: { approvalId: 'approval-1', kind: 'command', state: 'pending' } },
            { sequence: 2, session: { providerId: 'gateway-a', remoteSessionId: 'session-1' }, turnId: 'turn-1', type: 'approval.resolved', approval: { approvalId: 'approval-1', kind: 'command', state: 'resolved', outcome: 'approved' } },
            { sequence: 3, session: { providerId: 'gateway-a', remoteSessionId: 'session-1' }, turnId: 'turn-1', type: 'turn.completed', output: [{ type: 'text', text: 'Assistant reply' }] },
          ].filter(event => event.sequence > afterSequence) : []
          value = { afterSequence, nextAfterSequence: events.at(-1)?.sequence ?? afterSequence, events }
        } else {
          value = { ok: false, error: { code: 'invalid-request', message: `Unexpected ${request.operation}` } }
        }
        queueMicrotask(() => (dom.window as unknown as { __cordisxProviderReceiveV1?: (response: string) => void })
          .__cordisxProviderReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value })))
      },
    })
    dom.window.eval(bundle)
    await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    const fixture = (dom.window as unknown as { __cordisxAgentLoopRuntimeFixture?: { client: BoundAgentLoopClient } }).__cordisxAgentLoopRuntimeFixture
    if (fixture === undefined) throw new Error('ctx.agentLoop fixture did not mount')
    const createdPromise = fixture.client.createOrBind({
      $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1', schemaVersion: 1,
      commandId: 'create-1', type: 'create-or-bind', definition: { agentId: 'internal-assistant', revision: 'r1' },
      definitions: [{
        $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1, contract: 'cordisx.agent-definition/v1', schemaVersion: 1,
        identity: { agentId: 'internal-assistant', revision: 'r1' },
        inherit: { promptSections: 'merge', rules: 'merge', skills: 'merge', tools: 'merge', mcpServers: 'merge', runtimeDefaults: 'merge' },
        promptSections: [
          { sectionId: 'intro', kind: 'introduction', text: 'Internal assistant' },
          { sectionId: 'personality', kind: 'personality', text: 'Concise' },
          { sectionId: 'memory', kind: 'memory', text: 'Remember the current task' },
        ],
      }],
      target: { mode: 'create' },
    })
    const created = await Promise.race([
      createdPromise,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`AgentLoop create timeout: ${JSON.stringify(requests)}`)), 2_000)),
    ])
    expect(created.status).toBe('accepted')
    if (created.status !== 'accepted') throw new Error('create-or-bind was not accepted')
    const subscription = await Promise.race([
      fixture.client.subscribe(created.binding, -1),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`AgentLoop subscribe timeout: ${JSON.stringify(requests)}`)), 2_000)),
    ])
    if (subscription.status !== 'accepted') throw new Error('subscription was not accepted')
    const iterator = subscription.handle.pages[Symbol.asyncIterator]()
    const nextPage = async () => await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`AgentLoop event timeout: ${JSON.stringify(requests)}`)), 2_000)),
    ])
    await nextPage()
    const sent = await Promise.race([fixture.client.send({
      $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1', schemaVersion: 1,
      commandId: 'send-1', type: 'send', binding: created.binding, content: [{ kind: 'text', text: 'Hello AgentLoop' }],
    }), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`AgentLoop send timeout: ${JSON.stringify(requests)}`)), 2_000))])
    expect(sent.status).toBe('accepted')
    const observed = []
    for (let index = 0; index < 6; index += 1) observed.push(...((await nextPage()).value?.events ?? []))
    expect(observed).toMatchObject([
      { type: 'message', message: { role: 'user', content: [{ kind: 'text', text: 'Hello AgentLoop' }] } },
      { type: 'lifecycle', lifecycle: { phase: 'turn.started' } },
      { type: 'approval', approval: { state: 'pending' } },
      { type: 'approval', approval: { state: 'resolved', outcome: 'approved' } },
      { type: 'message', message: { role: 'assistant', content: [{ kind: 'text', text: 'Assistant reply' }] } },
      { type: 'lifecycle', lifecycle: { phase: 'turn.completed' } },
    ])
    expect(requests.find(request => request.operation === 'agent-loop.create')?.input).toMatchObject({
      developerInstructions: expect.stringContaining('## introduction:intro'),
    })
    expect(requests.find(request => request.operation === 'turns.submit')?.input).toMatchObject({ message: 'Hello AgentLoop' })
    expect(JSON.stringify(requests)).not.toContain('imagePath')
    subscription.handle.unsubscribe()
    await (dom.window as unknown as { __cordisxRuntime?: { dispose(): Promise<void> } }).__cordisxRuntime?.dispose()
    expect((dom.window as unknown as { __cordisxAgentLoopRuntimeFixture?: unknown }).__cordisxAgentLoopRuntimeFixture).toBeUndefined()
    dom.window.close()
  })
})
