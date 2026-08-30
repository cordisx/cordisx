import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type {
  AgentConversationActiveRunDescriptor,
  AgentConversationParticipant,
} from '@cordisx/protocol/agent-conversation-shell/v2'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@oneworks/avatar-react/style.css', () => ({
  default: '.oneworks-avatar,.oneworks-avatar-editor{box-sizing:border-box}.oneworks-avatar{position:relative}.oneworks-avatar>.interactive-avatar{width:100%;height:100%}',
}))
vi.mock('@oneworks/avatar-react', () => ({
  Avatar: ({ className }: { readonly className?: string }) => <span className={`oneworks-avatar ${className ?? ''}`} />,
}))

import {
  HostAgentIdentityAvatarButton,
  HostAgentIdentityPanel,
  canOpenHostAgentIdentity,
  createHostAgentIdentityPresentation,
  projectHostAgentIdentityFromShell,
  type HostAgentIdentityPanelCopy,
  type HostAgentIdentityPresentation,
} from '../packages/cli/src/renderer/host-ui/conversation/AgentIdentityPanel.js'
import {
  HostAgentTaskDetailsNavigator,
  validateAgentLoopTaskDetailsUrl,
} from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'
import { AGENT_CONVERSATION_STYLES } from '../packages/cli/src/renderer/host-ui/conversation/styles.js'

const copy: HostAgentIdentityPanelCopy = {
  settings: 'Agent settings',
  close: 'Close Agent panel',
  introduction: 'Introduction',
  activeSessions: 'Active sessions',
  noActiveSessions: 'No active sessions',
  sessionCount: count => `${count} active sessions`,
  lifecycle: { active: 'Active', running: 'Running', waiting: 'Waiting', attention: 'Needs attention' },
}

const participant: AgentConversationParticipant = {
  participantId: 'participant-lead',
  role: 'agent',
  displayName: { key: 'agent.lead', fallback: 'Lead' },
  agentIdentity: { agentId: 'lead', revision: 'r1' },
  avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' }),
}

function activeRun(overrides: Partial<AgentConversationActiveRunDescriptor> = {}): AgentConversationActiveRunDescriptor {
  return {
    participantId: participant.participantId,
    memberId: 'member-lead',
    runId: 'run-1',
    lifecycle: { phase: 'running', updatedAt: '2026-08-31T12:00:00.000Z' },
    detailsUrl: { url: 'app://-/simulator/tasks/task-lead', target: 'host' },
    ...overrides,
  }
}

function presentation(overrides: Partial<HostAgentIdentityPresentation> = {}): HostAgentIdentityPresentation {
  return {
    participant,
    name: 'Lead',
    introduction: 'Coordinates the room and delegates focused work.',
    activeSessions: [{ run: activeRun(), roomLabel: 'Launch room', taskLabel: 'Lead task · Running' }],
    ...overrides,
  }
}

const previousGlobals = new Map<string, unknown>()

interface DomHarness { readonly dom: JSDOM; readonly root: Root; close(): Promise<void> }

async function install(element: React.ReactNode): Promise<DomHarness> {
  const dom = new JSDOM('<!doctype html><html><body><div data-cordisx-app-theme="dark"><button id="before">Before</button><div id="root"></div></div></body></html>', { url: 'app://-/index.html' })
  for (const [key, value] of Object.entries({
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    KeyboardEvent: dom.window.KeyboardEvent,
    PointerEvent: dom.window.PointerEvent ?? dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    if (!previousGlobals.has(key)) previousGlobals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  const root = createRoot(dom.window.document.getElementById('root')!)
  await act(async () => root.render(element))
  return {
    dom,
    root,
    async close() { await act(async () => root.unmount()); dom.window.close() },
  }
}

afterEach(() => {
  for (const [key, value] of previousGlobals) Reflect.set(globalThis, key, value)
  previousGlobals.clear()
})

describe('Host Agent task details URL navigator', () => {
  it('preserves exact formal v2 URLs and delegates only to the matching Host boundary', async () => {
    const calls: string[] = []
    const navigator = new HostAgentTaskDetailsNavigator({
      navigateHost: url => { calls.push(`host:${url}`) },
      navigateExternal: url => { calls.push(`external:${url}`) },
    })
    await navigator.navigate({ url: 'app://-/simulator/tasks/task-1', target: 'host' })
    await navigator.navigate({ url: 'https://tasks.example/task-2', target: 'external' })
    await navigator.navigate({ url: 'codex://tasks/task-3', target: 'external' })
    await navigator.navigate({ url: 'claude://tasks/task-4', target: 'external' })
    expect(calls).toEqual([
      'host:app://-/simulator/tasks/task-1',
      'external:https://tasks.example/task-2',
      'external:codex://tasks/task-3',
      'external:claude://tasks/task-4',
    ])
  })

  it('rejects target mismatch, credentials, unsafe protocols, whitespace, and unknown fields before side effects', async () => {
    const navigateHost = vi.fn()
    const navigateExternal = vi.fn()
    const navigator = new HostAgentTaskDetailsNavigator({ navigateHost, navigateExternal })
    const invalid = [
      { url: 'https://tasks.example/host-mismatch', target: 'host' },
      { url: 'app://-/external-mismatch', target: 'external' },
      { url: 'http://tasks.example/task', target: 'external' },
      { url: 'file:///tmp/task', target: 'external' },
      { url: 'data:text/html,task', target: 'external' },
      { url: 'javascript:alert(1)', target: 'external' },
      { url: 'blob:https://tasks.example/id', target: 'external' },
      { url: 'https://user:secret@tasks.example/task', target: 'external' },
      { url: 'app://-/task?view=trace', target: 'host' },
      { url: 'app://-/task#trace', target: 'host' },
      { url: 'app://-/task%0Atrace', target: 'host' },
      { url: 'app://-/task%2ftrace', target: 'host' },
      { url: ' app://-/task', target: 'host' },
      { url: 'app://-/task', target: 'host', capability: 'opaque' },
    ]
    for (const value of invalid) expect(() => navigator.navigate(value as never)).toThrow()
    expect(navigateHost).not.toHaveBeenCalled()
    expect(navigateExternal).not.toHaveBeenCalled()
    expect(() => validateAgentLoopTaskDetailsUrl({ url: 'not a URL', target: 'host' } as never)).toThrow()
  })
})

describe('Host Agent identity panel model', () => {
  it('consumes formal participant.agentIdentity and top-level activeRuns without guessing identity from names or order', () => {
    const input = presentation({
      activeSessions: [
        { run: activeRun(), roomLabel: 'Room A', taskLabel: 'Lead task' },
        { run: activeRun({ runId: 'run-2', detailsUrl: { url: 'codex://tasks/lead-2', target: 'external' }, lifecycle: { phase: 'attention' } }), roomLabel: 'Room B', taskLabel: 'Lead review' },
      ],
    })
    const model = createHostAgentIdentityPresentation(input)
    expect(model).not.toBe(input)
    expect(model.participant.agentIdentity).toEqual({ agentId: 'lead', revision: 'r1' })
    expect(model.activeSessions.map(session => session.run)).toEqual(input.activeSessions.map(session => session.run))
    expect(Object.isFrozen(model)).toBe(true)
    expect(Object.isFrozen(model.participant)).toBe(true)
    expect(Object.isFrozen(model.activeSessions)).toBe(true)
    expect(canOpenHostAgentIdentity(model)).toBe(true)
  })

  it('rejects cross-participant and duplicate member/run associations', () => {
    expect(() => createHostAgentIdentityPresentation(presentation({ activeSessions: [{
      run: activeRun({ participantId: 'participant-reviewer' }), roomLabel: 'Room', taskLabel: 'Task',
    }] }))).toThrow('crosses participant identity')
    const first = { run: activeRun(), roomLabel: 'Room', taskLabel: 'Task' }
    expect(() => createHostAgentIdentityPresentation(presentation({ activeSessions: [first, { ...first }] })))
      .toThrow('duplicate participant/member/run')
  })

  it('keeps human, system, and identity-less agent participants non-interactive', () => {
    for (const candidate of [
      { participantId: 'human', role: 'human', displayName: { key: 'human', fallback: 'Human' } },
      { participantId: 'system', role: 'system', displayName: { key: 'system', fallback: 'System' } },
      { participantId: 'agent', role: 'agent', displayName: { key: 'agent', fallback: 'Agent' } },
    ] satisfies AgentConversationParticipant[]) {
      expect(canOpenHostAgentIdentity(createHostAgentIdentityPresentation(presentation({ participant: candidate, activeSessions: [] })))).toBe(false)
    }
  })

  it('filters the atomic Shell v2 activeRuns snapshot by exact participant and exact Agent identity', () => {
    const reviewer: AgentConversationParticipant = {
      participantId: 'participant-reviewer', role: 'agent', displayName: { key: 'reviewer', fallback: 'Reviewer' },
      agentIdentity: { agentId: 'reviewer', revision: 'r2' },
    }
    const reviewerRun = activeRun({
      participantId: reviewer.participantId,
      memberId: 'member-reviewer',
      runId: 'run-reviewer',
      detailsUrl: { url: 'app://-/simulator/tasks/reviewer', target: 'host' },
    })
    const selection = {
      kind: 'room', roomId: 'room-1', title: { key: 'room', fallback: 'Room' }, multiParticipant: true,
      participantPresentation: 'host-initials', participants: [participant, reviewer], activeRuns: [reviewerRun, activeRun()],
    } as const
    const model = projectHostAgentIdentityFromShell(
      selection,
      participant.participantId,
      { identity: participant.agentIdentity!, name: 'Lead exact', introduction: 'Effective introduction' },
      run => ({ roomLabel: 'Room exact', taskLabel: `Task ${run.runId}` }),
    )!
    expect(model.name).toBe('Lead exact')
    expect(model.introduction).toBe('Effective introduction')
    expect(model.activeSessions).toHaveLength(1)
    expect(model.activeSessions[0]?.run.runId).toBe('run-1')
    expect(() => projectHostAgentIdentityFromShell(
      selection,
      participant.participantId,
      { identity: reviewer.agentIdentity!, name: 'Wrong', introduction: 'Wrong' },
      () => ({ roomLabel: 'Room', taskLabel: 'Task' }),
    )).toThrow('does not match')
    expect(projectHostAgentIdentityFromShell({ kind: 'no-room' }, participant.participantId, {
      identity: participant.agentIdentity!, name: 'Lead', introduction: 'Intro',
    }, () => ({ roomLabel: 'Room', taskLabel: 'Task' }))).toBeUndefined()
  })
})

describe('Host Agent identity panel interaction', () => {
  it('renders effective identity content, navigates exact stored URLs, and never exposes ids, handles, or URLs in DOM', async () => {
    const navigateHost = vi.fn()
    const settings = vi.fn()
    const navigator = new HostAgentTaskDetailsNavigator({ navigateHost, navigateExternal: vi.fn() })
    function Harness() {
      const [open, setOpen] = useState(false)
      return <>
        <HostAgentIdentityAvatarButton presentation={presentation()} label="Open Lead identity" onOpen={() => setOpen(true)} />
        <HostAgentIdentityPanel open={open} presentation={presentation()} copy={copy} navigator={navigator} onOpenChange={setOpen} onSettings={settings} />
      </>
    }
    const harness = await install(<Harness />)
    const trigger = harness.dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!
    const style = harness.dom.window.document.createElement('style')
    style.textContent = AGENT_CONVERSATION_STYLES
    harness.dom.window.document.head.append(style)
    const computed = harness.dom.window.getComputedStyle(trigger)
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-label')).toBe('Open Lead identity')
    expect(computed.backgroundColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/)
    expect(computed.borderTopWidth).toBe('0px')
    expect(computed.paddingTop).toBe('0px')
    expect(computed.boxShadow).toBe('none')
    expect(AGENT_CONVERSATION_STYLES).toContain('.cx-agent-identity-avatar-button:focus:not(:focus-visible)')
    expect(AGENT_CONVERSATION_STYLES).toContain('.cx-agent-identity-avatar-button:focus-visible')
    await act(async () => trigger.click())
    const panel = harness.dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.textContent).toContain('Lead')
    expect(panel.textContent).toContain('Coordinates the room and delegates focused work.')
    expect(panel.textContent).toContain('Launch room')
    expect(panel.textContent).toContain('Lead task · Running')
    const html = panel.outerHTML
    for (const secret of ['participant-lead', 'member-lead', 'run-1', 'task-lead', 'agentId', 'revision', 'lead@r1']) expect(html).not.toContain(secret)

    await act(async () => harness.dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-session')!.click())
    expect(navigateHost).toHaveBeenCalledWith('app://-/simulator/tasks/task-lead')
    expect(harness.dom.window.document.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => trigger.click())
    await act(async () => harness.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Agent settings"]')!.click())
    expect(settings).toHaveBeenCalledWith({ agentId: 'lead', revision: 'r1' })
    await harness.close()
  })

  it('traps focus, closes on Escape and outside pointer, and returns focus to the exact trigger', async () => {
    const navigator = new HostAgentTaskDetailsNavigator({ navigateHost: vi.fn(), navigateExternal: vi.fn() })
    function Harness() {
      const [open, setOpen] = useState(false)
      return <>
        <HostAgentIdentityAvatarButton presentation={presentation()} label="Open Lead identity" onOpen={() => setOpen(true)} />
        <HostAgentIdentityPanel open={open} presentation={presentation()} copy={copy} navigator={navigator} onOpenChange={setOpen} onSettings={vi.fn()} />
      </>
    }
    const harness = await install(<Harness />)
    const trigger = harness.dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!
    trigger.focus()
    await act(async () => trigger.click())
    const settings = harness.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Agent settings"]')!
    const session = harness.dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-session')!
    expect(harness.dom.window.document.activeElement).toBe(settings)
    session.focus()
    await act(async () => session.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    expect(harness.dom.window.document.activeElement).toBe(settings)
    await act(async () => settings.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(harness.dom.window.document.querySelector('[role="dialog"]')).toBeNull()
    expect(harness.dom.window.document.activeElement).toBe(trigger)

    await act(async () => trigger.click())
    const overlay = harness.dom.window.document.querySelector<HTMLElement>('.cx-agent-identity-overlay')!
    await act(async () => overlay.dispatchEvent(new harness.dom.window.MouseEvent('pointerdown', { bubbles: true })))
    expect(harness.dom.window.document.querySelector('[role="dialog"]')).toBeNull()
    expect(harness.dom.window.document.activeElement).toBe(trigger)
    await harness.close()
  })

  it('atomically reflects active-run replacement and cleans up when the Agent unloads', async () => {
    const navigator = new HostAgentTaskDetailsNavigator({ navigateHost: vi.fn(), navigateExternal: vi.fn() })
    function Harness() {
      const [open, setOpen] = useState(true)
      const [current, setCurrent] = useState<HostAgentIdentityPresentation | undefined>(presentation({
        activeSessions: [
          { run: activeRun(), roomLabel: 'Room A', taskLabel: 'Run A' },
          { run: activeRun({ runId: 'run-2' }), roomLabel: 'Room B', taskLabel: 'Run B' },
        ],
      }))
      return <>
        <button id="replace" onClick={() => setCurrent(presentation({ activeSessions: [{ run: activeRun({ runId: 'run-2', lifecycle: { phase: 'waiting' } }), roomLabel: 'Room B', taskLabel: 'Run B' }] }))}>Replace</button>
        <button id="unload" onClick={() => setCurrent(undefined)}>Unload</button>
        <HostAgentIdentityPanel open={open} presentation={current} copy={copy} navigator={navigator} onOpenChange={setOpen} onSettings={vi.fn()} />
      </>
    }
    const harness = await install(<Harness />)
    expect(harness.dom.window.document.querySelectorAll('.cx-agent-identity-session')).toHaveLength(2)
    await act(async () => harness.dom.window.document.getElementById('replace')!.click())
    expect(harness.dom.window.document.querySelectorAll('.cx-agent-identity-session')).toHaveLength(1)
    expect(harness.dom.window.document.querySelector('.cx-agent-identity-session')?.textContent).toContain('Waiting')
    await act(async () => harness.dom.window.document.getElementById('unload')!.click())
    expect(harness.dom.window.document.querySelector('[role="dialog"]')).toBeNull()
    await harness.close()
  })

  it('renders no identity trigger for human, system, or identity-less Agent subjects', async () => {
    const candidates: AgentConversationParticipant[] = [
      { participantId: 'human', role: 'human', displayName: { key: 'human', fallback: 'Human' } },
      { participantId: 'system', role: 'system', displayName: { key: 'system', fallback: 'System' } },
      { participantId: 'agent', role: 'agent', displayName: { key: 'agent', fallback: 'Agent' } },
    ]
    const harness = await install(<>{candidates.map(candidate => <HostAgentIdentityAvatarButton
      key={candidate.participantId}
      presentation={presentation({ participant: candidate, name: candidate.displayName.fallback, activeSessions: [] })}
      label="Forbidden identity entry"
      onOpen={vi.fn()}
    />)}</>)
    expect(harness.dom.window.document.querySelectorAll('.cx-agent-identity-avatar-button')).toHaveLength(0)
    expect(harness.dom.window.document.querySelectorAll('.cxa-avatar')).toHaveLength(3)
    await harness.close()
  })
})
