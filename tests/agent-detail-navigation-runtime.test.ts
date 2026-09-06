import { describe, expect, it } from 'vitest'
import type { AgentOptions, AgentSetup } from '@cordisx/protocol/agents/v1'
import type { UserMessage } from '@cordisx/protocol/sessions/v1'

import {
  CordisXAgentSessionRuntime,
  type CordisXPrivateAgentDriver,
} from '../packages/cli/src/renderer/agent-session-runtime.js'

const owner = { pluginId: 'file:///plugins/chatroom.ts:chatroom', generation: 1 } as const
const otherOwner = { pluginId: 'file:///plugins/other.ts:other', generation: 1 } as const
const setup: AgentSetup = {
  definition: { agentId: 'chatroom.lead', revision: 'revision-1' },
  definitions: [{
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId: 'base', revision: 'revision-base' },
    name: 'Base',
    promptSections: [{ sectionId: 'base', kind: 'introduction', text: 'Base.' }],
    inherit: {
      promptSections: 'none',
      rules: 'none',
      skills: 'none',
      tools: 'none',
      mcpServers: 'none',
      runtimeDefaults: 'none',
    },
  }, {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId: 'chatroom.lead', revision: 'revision-1' },
    name: 'Lead',
    extends: [{ agentId: 'base', revision: 'revision-base' }],
    promptSections: [{ sectionId: 'role', kind: 'role', text: 'Lead.' }],
    inherit: {
      promptSections: 'append',
      rules: 'merge',
      skills: 'merge',
      tools: 'merge',
      mcpServers: 'merge',
      runtimeDefaults: 'merge',
      avatar: 'inherit',
    },
  }],
}

class DetailDriver implements CordisXPrivateAgentDriver {
  private readonly replacement = new Set<() => void>()
  constructor(private readonly refFor: (sessionId: string) => string) {}
  async create(input: { readonly sessionId: string }) {
    return { status: 'accepted' as const, detail: { kind: 'host' as const, ref: this.refFor(input.sessionId) } }
  }
  async resume(input: { readonly sessionId: string }) {
    return { status: 'accepted' as const, detail: { kind: 'host' as const, ref: this.refFor(input.sessionId) } }
  }
  async submit(_input: { readonly message: UserMessage }) {
    return 'accepted' as const
  }
  async discard() {
    return 'accepted' as const
  }
  async cancel() {
    return 'accepted' as const
  }
  onReplacement(listener: () => void) {
    this.replacement.add(listener)
    return () => this.replacement.delete(listener)
  }
  replace(): void {
    for (const listener of this.replacement) listener()
  }
  dispose(): void {
    this.replacement.clear()
  }
}

async function create(runtime: CordisXAgentSessionRuntime, sessionId: string, currentOwner = owner) {
  const result = await runtime.create(currentOwner, { sessionId, options: {} satisfies AgentOptions, setup })
  if (result.status !== 'accepted') throw new Error('fixture Agent acquisition failed')
  return result
}

describe('agent detail navigation', () => {
  it('projects and opens one exact current same-owner stored reference without an Agent lookup', async () => {
    const opened: { readonly ref: string; readonly sessionId: string }[] = []
    const runtime = new CordisXAgentSessionRuntime({
      driver: new DetailDriver(sessionId => `deterministic-agent-session:${sessionId}`),
      authorize: async () => true,
      navigateAgentDetail: async (detail, sessionId) => {
        opened.push({ ref: detail.ref, sessionId })
      },
    })
    await create(runtime, 'cx-session.detail-one')
    const reference = await runtime.getAgentSessionDetailReference(owner, { sessionId: 'cx-session.detail-one' })
    expect(reference).toEqual({
      status: 'accepted',
      sessionId: 'cx-session.detail-one',
      target: { kind: 'host', ref: 'deterministic-agent-session:cx-session.detail-one' },
    })
    if (reference.status !== 'accepted') throw new Error('detail reference was unavailable')
    await expect(runtime.openAgentDetail(owner, { target: reference.target })).resolves.toEqual({
      status: 'accepted',
      code: 'opened',
    })
    expect(opened).toEqual([{ ref: reference.target.ref, sessionId: 'cx-session.detail-one' }])
    await expect(runtime.getAgentSessionDetailReference(otherOwner, { sessionId: 'cx-session.detail-one' })).resolves
      .toEqual({
        status: 'denied',
        code: 'permission-denied',
      })
    await runtime.dispose()
  })

  it('fails closed for unknown, ambiguous, and connection-replaced detail references', async () => {
    const driver = new DetailDriver(() => 'codex-thread:shared-thread')
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => true,
      navigateAgentDetail: async () => {},
    })
    await create(runtime, 'cx-session.detail-first')
    await create(runtime, 'cx-session.detail-second')
    await expect(runtime.openAgentDetail(owner, { target: { kind: 'host', ref: 'unknown-detail' } })).resolves.toEqual({
      status: 'unavailable',
      code: 'unknown-detail',
    })
    await expect(runtime.openAgentDetail(owner, { target: { kind: 'host', ref: 'codex-thread:shared-thread' } }))
      .resolves.toEqual({
        status: 'denied',
        code: 'ambiguous-detail',
      })
    driver.replace()
    await expect(runtime.getAgentSessionDetailReference(owner, { sessionId: 'cx-session.detail-first' })).resolves
      .toEqual({
        status: 'unavailable',
        code: 'connection-replaced',
      })
    await runtime.dispose()
  })
})
