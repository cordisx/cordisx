import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  createCodexDesktopAgentSessionSmokeController,
  manifest,
} from './fixtures/codex-desktop-agent-session-smoke.js'
import type { Context } from '@deepseek-ai/cordis'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('Codex Desktop Agent Session live harness', () => {
  it('uses one isolated app profile and the existing authenticated Desktop connection', async () => {
    const wrapper = await readFile(
      path.join(root, 'packages/cli/scripts/run-codex-desktop-agent-session-harness.mjs'),
      'utf8',
    )
    const runner = await readFile(path.join(root, 'packages/cli/scripts/run-isolated-app-smoke.mjs'), 'utf8')
    expect(wrapper).toContain("bundleId: 'com.openai.codex'")
    expect(wrapper).toContain("appVersion: '26.818.61809'")
    expect(wrapper).toContain("buildNumber: '7019'")
    expect(wrapper).toContain('CORDISX_HOME: cordisxHome')
    expect(wrapper).toContain('writeDesktopAgentSessionHarnessReport')
    expect(wrapper).toContain('waitForOwnedProfileQuiescence')
    expect(wrapper).toContain('sharedHome: process.env.HOME')
    expect(wrapper).toContain('sharedCodexHome: process.env.CODEX_HOME')
    expect(wrapper).toContain('secondProviderStarted: false')
    expect(wrapper).toContain('appAsarPatched: false')
    expect(wrapper).toContain("'--desktop-agent-session-harness'")
    expect(runner).toContain("'packages/cli/scripts/codex-desktop-agent-session-smoke.mjs'")
    expect(runner).toContain("'--desktop-agent-session-harness requires --dev-config")
    expect(runner).toContain('desktopAgentSessionRendererTimeoutMs(desktopAgentSessionHarness)')
  })

  it('declares every public Agent Session capability exercised by the fixture', () => {
    expect(manifest.capabilities.map(capability => capability.name)).toEqual([
      'agents.create',
      'agents.resume',
      'agents.get',
      'agents.message.submit',
      'agents.message.cancel',
      'agents.cancel',
      'agents.live.subscribe',
      'sessions.get',
      'sessions.read',
      'sessions.subscribe',
      'approvals.request',
      'approvals.answer',
    ])
    expect(manifest.capabilities.every(capability => capability.required)).toBe(true)
  })

  it('stamps send provenance from the accepted AgentHandle owner before entering the adapter-facing send', async () => {
    const adapterSend = vi.fn(async (message: unknown) => ({ status: 'accepted', message }))
    const owner = { pluginId: 'file:///fixture.ts:fixture', generation: 7 }
    const agent = {
      id: 'cx-session.fixture',
      generation: 1,
      options: {},
      inbox: { nextTurn: [], nextStep: [] },
      status: { status: 'available', value: 'idle' },
      session: {
        id: 'cx-session.fixture',
        generation: 1,
        header: { id: 'cx-session.fixture', formatVersion: 1, createdAt: 1, isSeeded: false },
      },
      send: adapterSend,
    }
    const handle = { agent, owner, dispose: vi.fn() }
    const ctx = {
      agents: { create: vi.fn(async () => ({ status: 'accepted', handle })) },
    } as unknown as Context
    const controller = createCodexDesktopAgentSessionSmokeController(ctx, { marker: 'fixture' })
    const wait = async () => {
      while (controller.snapshot().busy) await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(controller.invoke('create', { sessionId: 'cx-session.fixture', mutationId: 'create-1' })).toBe(true)
    await wait()
    expect(controller.invoke('send', { mode: 'send', messageId: 'message-1', text: 'hello' })).toBe(true)
    await wait()
    expect(adapterSend).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation },
      }),
      'next-turn',
      true,
    )
    expect(controller.snapshot().last).toMatchObject({ name: 'send', ok: true })
  })
})
