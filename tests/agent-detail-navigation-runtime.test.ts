import { Context } from '@deepseek-ai/cordis'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/ownership.js'
import { describe, expect, it, vi } from 'vitest'
import { NativeSessionDetailReferences } from '../packages/cli/src/renderer/native-session-detail-references.js'
import type { AgentOptions, AgentSetup } from '@cordisx/protocol/agents/v1'
import type { UserMessage } from '@cordisx/protocol/sessions/v1'

import {
  CordisXAgentDetailNavigationService,
  CordisXAgentSessionDetailReferenceService,
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

describe('agent detail navigation v2', () => {
  it('opens an unloaded historical Session without widening v1 or invoking execution', async () => {
    const provider = new NativeSessionDetailReferences()
    const runtimeOwner = owner
    provider.register(runtimeOwner, {
      active: () => true,
      read: async () => ({ threadId: 'native-history', revision: 1 }),
    })
    const driver = new DetailDriver(id => `current:${id}`)
    const createSpy = vi.spyOn(driver, 'create')
    const resumeSpy = vi.spyOn(driver, 'resume')
    const submitSpy = vi.spyOn(driver, 'submit')
    const navigate = vi.fn()
    let authorized = true
    const runtime = new CordisXAgentSessionRuntime({
      driver,
      authorize: async () => authorized,
      historicalAgentDetails: provider,
      navigateAgentDetail: navigate,
    })
    await expect(runtime.getAgentSessionDetailReference(owner, { sessionId: 'history' })).resolves.toMatchObject({
      status: 'unavailable',
    })
    const reference = await runtime.getAgentSessionDetailReferenceV2(owner, { sessionId: 'history' })
    if (reference.status !== 'accepted') throw new Error('historical reference unavailable')
    await expect(runtime.openAgentDetail(owner, { target: reference.target })).resolves.toMatchObject({
      status: 'unavailable',
    })
    await expect(runtime.openAgentDetailV2(otherOwner, { target: reference.target })).resolves.toMatchObject({
      status: 'unavailable',
    })
    await expect(runtime.openAgentDetailV2(owner, { target: reference.target })).resolves.toEqual({
      status: 'accepted',
      code: 'opened',
    })
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: 'host', ref: 'codex-thread:native-history' }, 'history')
    authorized = false
    await expect(runtime.openAgentDetailV2(owner, { target: reference.target })).resolves.toEqual({
      status: 'denied',
      code: 'permission-denied',
    })
    authorized = true
    driver.replace()
    await expect(runtime.openAgentDetailV2(owner, { target: reference.target })).resolves.toMatchObject({
      status: 'unavailable',
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(submitSpy).not.toHaveBeenCalled()
    await runtime.dispose()
    provider.dispose()
  })

  it('reports a missing historical bridge and preserves known foreign/current record checks', async () => {
    const runtime = new CordisXAgentSessionRuntime({
      driver: new DetailDriver(id => `current:${id}`),
      authorize: async () => true,
    })
    await expect(runtime.getAgentSessionDetailReferenceV2(owner, { sessionId: 'history' })).resolves.toEqual({
      status: 'unavailable',
      code: 'unsupported',
    })
    await create(runtime, 'current')
    await expect(runtime.getAgentSessionDetailReferenceV2(otherOwner, { sessionId: 'current' })).resolves.toEqual({
      status: 'denied',
      code: 'permission-denied',
    })
    await expect(runtime.getAgentSessionDetailReferenceV2(owner, { sessionId: 'current' })).resolves.toMatchObject({
      status: 'accepted',
    })
    await runtime.dispose()
  })
})

it('exposes the additive methods on the real owner-bound Cordis services', async () => {
  const context = new Context().extend({
    [CORDISX_PLUGIN_SOURCE]: 'file:///plugins/public.ts',
    [CORDISX_PLUGIN_ID]: 'chatroom',
  })
  const provider = new NativeSessionDetailReferences()
  const runtime = new CordisXAgentSessionRuntime({
    driver: new DetailDriver(id => id),
    authorize: async () => true,
    historicalAgentDetails: provider,
    navigateAgentDetail: vi.fn(),
  })
  provider.register(runtime.ownerFromContext(context), {
    active: () => true,
    read: async () => ({ threadId: 'history', revision: 1 }),
  })
  const references = context.plugin(CordisXAgentSessionDetailReferenceService, runtime)
  const navigation = context.plugin(CordisXAgentDetailNavigationService, runtime)
  await references
  await navigation
  try {
    expect((await context.agentSessionDetailReferences.get({ sessionId: 'history' })).status).toBe('unavailable')
    const result = await context.agentSessionDetailReferences.getV2({ sessionId: 'history' })
    if (result.status !== 'accepted') throw new Error('v2 service unavailable')
    expect((await context.agentDetailNavigation.open({ target: result.target })).status).toBe('unavailable')
    expect(await context.agentDetailNavigation.openV2({ target: result.target })).toEqual({
      status: 'accepted',
      code: 'opened',
    })
  } finally {
    await navigation.dispose()
    await references.dispose()
    await runtime.dispose()
    provider.dispose()
  }
})

it('opens disposed and previous-generation historical Agents through fresh mapping authority without resuming them', async () => {
  const provider = new NativeSessionDetailReferences()
  const read = vi.fn(async () => ({ threadId: 'persisted-history', revision: 1 }))
  const unregister = provider.register(owner, { active: () => true, read })
  const driver = new DetailDriver(id => `current:${id}`)
  const runtime = new CordisXAgentSessionRuntime({
    driver,
    authorize: async () => true,
    historicalAgentDetails: provider,
    navigateAgentDetail: vi.fn(),
  })
  const acquired = await create(runtime, 'ended-session')
  await acquired.handle.dispose()
  const creates = vi.spyOn(driver, 'create')
  const resumes = vi.spyOn(driver, 'resume')
  const submits = vi.spyOn(driver, 'submit')
  expect((await runtime.getAgentSessionDetailReference(owner, { sessionId: 'ended-session' })).status).toBe(
    'unavailable',
  )
  const ended = await runtime.getAgentSessionDetailReferenceV2(owner, { sessionId: 'ended-session' })
  if (ended.status !== 'accepted') throw new Error('disposed historical detail unavailable')
  expect(await runtime.openAgentDetailV2(owner, { target: ended.target })).toEqual({
    status: 'accepted',
    code: 'opened',
  })
  unregister()
  const nextOwner = { ...owner, generation: 2 }
  provider.register(nextOwner, { active: () => true, read })
  const current = await runtime.getAgentSessionDetailReferenceV2(nextOwner, { sessionId: 'ended-session' })
  if (current.status !== 'accepted') throw new Error('new owner generation historical detail unavailable')
  expect(current.target).not.toEqual(ended.target)
  expect((await runtime.openAgentDetailV2(nextOwner, { target: ended.target })).status).toBe('unavailable')
  expect(await runtime.openAgentDetailV2(nextOwner, { target: current.target })).toEqual({
    status: 'accepted',
    code: 'opened',
  })
  expect((await runtime.getAgentSessionDetailReferenceV2(owner, { sessionId: 'ended-session' })).status).toBe(
    'unavailable',
  )
  expect(creates).not.toHaveBeenCalled()
  expect(resumes).not.toHaveBeenCalled()
  expect(submits).not.toHaveBeenCalled()
  await runtime.dispose()
  provider.dispose()
})
