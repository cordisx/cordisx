import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentLoopAuthority, agentLoopCommandDigest } from '../packages/cli/src/launcher/agent-loop-authority.js'

const roots: string[] = []
afterEach(async () =>
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
)

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'cordisx-agent-loop-authority-'))
  roots.push(value)
  return value
}

const scope = {
  profileId: 'work',
  compositionGeneration: 'composition-1',
  ownerKey: 'file:///private/plugin.ts\u0000chatroom',
}
const provider = { providerId: 'local-codex', providerGeneration: 'provider-1' }

describe('launcher-owned AgentLoop authority', () => {
  it('persists only digests and bounded locators with private modes', async () => {
    const home = await root()
    const authority = await AgentLoopAuthority.open(home, 'work')
    const command = { type: 'send', commandId: 'operation-1', content: [{ kind: 'text', text: 'secret prompt body' }] }
    const commandDigest = agentLoopCommandDigest(command)
    expect(await authority.plan({ scope, operationId: 'operation-1', commandDigest, kind: 'send', provider })).toEqual({
      status: 'planned',
    })
    await authority.rememberTask(scope, {
      task: 'task-1',
      binding: { bindingId: 'binding-1', generation: 1 },
      ...provider,
      remoteSessionId: 'session-1',
      definition: { agentId: 'agent-1', revision: 'rev-1' },
      state: 'active',
    })
    await authority.commit({
      scope,
      operationId: 'operation-1',
      commandDigest,
      result: { status: 'accepted', turn: 'turn-1', messageId: 'message-1' },
    })
    const file = path.join(home, 'state', 'profiles', 'work', 'agent-loop', 'authority.v1.json')
    const encoded = await readFile(file, 'utf8')
    expect(encoded).not.toContain('secret prompt body')
    expect(encoded).not.toContain('file:///private/plugin.ts')
    expect(encoded).not.toContain('operation-1')
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('fences owner, command digest, and provider generation without duplicate execution', async () => {
    const authority = await AgentLoopAuthority.open(await root(), 'work')
    const digest = agentLoopCommandDigest({ type: 'send', value: 1 })
    expect(await authority.plan({ scope, operationId: 'operation-1', commandDigest: digest, kind: 'send', provider }))
      .toEqual({ status: 'planned' })
    expect(await authority.plan({ scope, operationId: 'operation-1', commandDigest: digest, kind: 'send', provider }))
      .toEqual({ status: 'reconciliation-required', provider })
    expect(
      (await authority.plan({
        scope,
        operationId: 'operation-1',
        commandDigest: agentLoopCommandDigest({ type: 'send', value: 2 }),
        kind: 'send',
        provider,
      })).status,
    ).toBe('conflict')
    await authority.rememberTask(scope, {
      task: 'task-1',
      binding: { bindingId: 'binding-1', generation: 1 },
      ...provider,
      remoteSessionId: 'session-1',
      definition: { agentId: 'agent-1', revision: 'rev-1' },
      state: 'active',
    })
    await authority.commit({
      scope,
      operationId: 'operation-1',
      commandDigest: digest,
      result: { status: 'accepted', operationId: 'operation-1' },
    })
    expect(authority.resolveTask({ ...scope, ownerKey: 'other' }, 'task-1')).toBeUndefined()
    expect(authority.resolveTask(scope, 'task-1')?.providerGeneration).toBe('provider-1')
    expect(authority.committedResults(scope)).toEqual([{
      kind: 'send',
      result: { status: 'accepted', operationId: 'operation-1' },
    }])
    expect(authority.committedResults({ ...scope, ownerKey: 'other' })).toEqual([])
    expect(
      await authority.plan({
        ...{
          scope: { ...scope, compositionGeneration: 'composition-after-reload' },
          operationId: 'operation-1',
          commandDigest: digest,
          kind: 'send',
          provider,
        },
      }),
    ).toEqual({ status: 'replay', result: { status: 'accepted', operationId: 'operation-1' } })
    expect(
      await authority.plan({
        scope,
        operationId: 'operation-1',
        commandDigest: digest,
        kind: 'send',
        provider: { providerId: 'local-codex', providerGeneration: 'provider-2' },
      }),
    ).toEqual({ status: 'reconciliation-required', provider })
    expect(
      await authority.plan({
        scope,
        operationId: 'operation-1',
        commandDigest: agentLoopCommandDigest({ type: 'create-or-bind', value: 'different' }),
        kind: 'create-or-bind',
        provider: { providerId: 'other-provider', providerGeneration: 'provider-1' },
      }),
    ).toEqual({ status: 'reconciliation-required', provider })
  })

  it('leaves a planned tombstone when crash injection fires before commit', async () => {
    const authority = await AgentLoopAuthority.open(await root(), 'work', {
      crash: {
        beforeCommit: () => {
          throw new Error('injected crash')
        },
      },
    })
    const commandDigest = agentLoopCommandDigest({ type: 'send' })
    await authority.plan({ scope, operationId: 'operation-crash', commandDigest, kind: 'send', provider })
    await expect(
      authority.commit({ scope, operationId: 'operation-crash', commandDigest, result: { raw: 'must-not-land' } }),
    ).rejects.toThrow('injected crash')
    expect(await authority.plan({ scope, operationId: 'operation-crash', commandDigest, kind: 'send', provider }))
      .toEqual({ status: 'reconciliation-required', provider })
    expect(JSON.stringify(authority.snapshotForTests())).not.toContain('must-not-land')
  })

  it('claims one semantic resource atomically and releases failed claims for a new operation', async () => {
    const authority = await AgentLoopAuthority.open(await root(), 'work')
    const firstDigest = agentLoopCommandDigest({ type: 'approval-decision', commandId: 'decision-1' })
    expect(
      await authority.plan({
        scope,
        operationId: 'decision-1',
        commandDigest: firstDigest,
        kind: 'approval-decision',
        provider,
        resourceKey: 'approval\0task-1\0turn-1\0approval-1',
      }),
    ).toEqual({ status: 'planned' })
    expect(
      await authority.plan({
        scope,
        operationId: 'decision-2',
        commandDigest: agentLoopCommandDigest({ type: 'approval-decision', commandId: 'decision-2' }),
        kind: 'approval-decision',
        provider,
        resourceKey: 'approval\0task-1\0turn-1\0approval-1',
      }),
    ).toEqual({ status: 'resource-conflict' })
    await authority.commit({
      scope,
      operationId: 'decision-1',
      commandDigest: firstDigest,
      result: { status: 'unavailable', code: 'approval-unavailable' },
    })
    expect(
      await authority.plan({
        scope,
        operationId: 'decision-3',
        commandDigest: agentLoopCommandDigest({ type: 'approval-decision', commandId: 'decision-3' }),
        kind: 'approval-decision',
        provider,
        resourceKey: 'approval\0task-1\0turn-1\0approval-1',
      }),
    ).toEqual({ status: 'planned' })
  })

  it('durably releases only failed introduction resources for retry across restart and provider replacement', async () => {
    const home = await root()
    const resourceKey = 'introduction\0task-1\0participant-1\0member-1\0run-1'
    const firstDigest = agentLoopCommandDigest({ type: 'request-member-self-introduction', commandId: 'intro-first' })
    const authority = await AgentLoopAuthority.open(home, 'work')
    expect(
      await authority.plan({
        scope,
        operationId: 'intro-first',
        commandDigest: firstDigest,
        kind: 'request-member-self-introduction',
        provider,
        resourceKey,
      }),
    ).toEqual({ status: 'planned' })
    await authority.commit({
      scope,
      operationId: 'intro-first',
      commandDigest: firstDigest,
      result: {
        status: 'accepted',
        turn: 'turn-intro-first',
        messageId: 'message-intro-first',
        locator: { remoteSessionId: 'session-1' },
        introductionState: 'pending',
      },
    })
    expect(
      await authority.plan({
        scope,
        operationId: 'intro-first',
        commandDigest: firstDigest,
        kind: 'request-member-self-introduction',
        provider,
        resourceKey,
      }),
    )
      .toMatchObject({ status: 'replay', result: { introductionState: 'pending' } })
    expect(
      await authority.plan({
        scope,
        operationId: 'intro-before-failure',
        commandDigest: agentLoopCommandDigest({
          type: 'request-member-self-introduction',
          commandId: 'intro-before-failure',
        }),
        kind: 'request-member-self-introduction',
        provider,
        resourceKey,
      }),
    )
      .toEqual({ status: 'resource-conflict' })

    await authority.observeIntroductionTerminal(provider, 'session-1', 'turn-intro-first', 'failed')
    await authority.observeIntroductionTerminal(provider, 'session-1', 'turn-intro-first', 'completed')
    expect(
      await authority.plan({
        scope,
        operationId: 'intro-first',
        commandDigest: firstDigest,
        kind: 'request-member-self-introduction',
        provider,
        resourceKey,
      }),
    )
      .toMatchObject({ status: 'replay', result: { introductionState: 'failed' } })

    await authority.closeProviderGeneration(provider)
    const restored = await AgentLoopAuthority.open(home, 'work')
    const replacement = { providerId: provider.providerId, providerGeneration: 'provider-2' }
    const retryDigest = agentLoopCommandDigest({ type: 'request-member-self-introduction', commandId: 'intro-retry' })
    expect(
      await restored.plan({
        scope: { ...scope, compositionGeneration: 'composition-reloaded' },
        operationId: 'intro-retry',
        commandDigest: retryDigest,
        kind: 'request-member-self-introduction',
        provider: replacement,
        resourceKey,
      }),
    )
      .toEqual({ status: 'planned' })
    await restored.commit({
      scope,
      operationId: 'intro-retry',
      commandDigest: retryDigest,
      result: {
        status: 'accepted',
        turn: 'turn-intro-retry',
        messageId: 'message-intro-retry',
        locator: { remoteSessionId: 'session-2' },
        introductionState: 'completed',
      },
    })
    await restored.observeIntroductionTerminal(replacement, 'session-2', 'turn-intro-retry', 'failed')
    expect(
      await restored.plan({
        scope,
        operationId: 'intro-retry',
        commandDigest: retryDigest,
        kind: 'request-member-self-introduction',
        provider: replacement,
        resourceKey,
      }),
    )
      .toMatchObject({ status: 'replay', result: { introductionState: 'completed' } })
    expect(
      await restored.plan({
        scope,
        operationId: 'intro-after-completed',
        commandDigest: agentLoopCommandDigest({
          type: 'request-member-self-introduction',
          commandId: 'intro-after-completed',
        }),
        kind: 'request-member-self-introduction',
        provider: replacement,
        resourceKey,
      }),
    )
      .toEqual({ status: 'resource-conflict' })
    expect(
      await restored.plan({
        scope,
        operationId: 'intro-distinct-resource',
        commandDigest: agentLoopCommandDigest({
          type: 'request-member-self-introduction',
          commandId: 'intro-distinct-resource',
        }),
        kind: 'request-member-self-introduction',
        provider: replacement,
        resourceKey: 'introduction\0task-1\0participant-2\0member-2\0run-2',
      }),
    )
      .toEqual({ status: 'planned' })
  })

  it('retains active operations and returns operation-expired only after the closed recovery window', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z')
    const authority = await AgentLoopAuthority.open(await root(), 'work', { now: () => now })
    const commandDigest = agentLoopCommandDigest({ type: 'send', commandId: 'durable-operation' })
    await authority.plan({ scope, operationId: 'durable-operation', commandDigest, kind: 'send', provider })
    await authority.rememberTask(scope, {
      task: 'task-1',
      binding: { bindingId: 'binding-1', generation: 1 },
      ...provider,
      remoteSessionId: 'session-1',
      definition: { agentId: 'agent-1', revision: 'rev-1' },
      state: 'active',
    })
    await authority.commit({
      scope,
      operationId: 'durable-operation',
      commandDigest,
      result: {
        status: 'accepted',
        locator: {
          task: 'task-1',
          binding: { bindingId: 'binding-1', generation: 1 },
          ...provider,
          remoteSessionId: 'session-1',
          definition: { agentId: 'agent-1', revision: 'rev-1' },
          state: 'active',
        },
      },
    })
    now = new Date('2027-01-01T00:00:00.000Z')
    expect(
      (await authority.plan({ scope, operationId: 'durable-operation', commandDigest, kind: 'send', provider })).status,
    ).toBe('replay')
    await authority.closeProviderGeneration(provider)
    now = new Date('2027-02-01T00:00:00.000Z')
    expect(await authority.plan({ scope, operationId: 'durable-operation', commandDigest, kind: 'send', provider }))
      .toEqual({ status: 'operation-expired' })
    now = new Date('2027-02-03T00:00:00.000Z')
    expect(await authority.plan({ scope, operationId: 'durable-operation', commandDigest, kind: 'send', provider }))
      .toEqual({ status: 'planned' })
  })
})
