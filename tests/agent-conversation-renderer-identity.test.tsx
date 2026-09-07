import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { EntityDirectoryAuthority, entityTreeDigest } from '../packages/cli/src/launcher/entity-directory.js'
import { entityInstallationId } from '../packages/cli/src/launcher/owner-document-rpc.js'
import {
  createEntityAwareIdentityResolver,
  entityDefinitionPresentation,
} from '../packages/cli/src/renderer/entity-definition-presentation.js'
import { readFile } from 'node:fs/promises'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import {
  AgentConversationRenderer,
  type AgentConversationRendererProps,
} from '../packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.js'
import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'
import { createHostRoomCompositeAvatarProjection } from '../packages/cli/src/renderer/host-ui/RoomCompositeAvatar.js'
import type { HostNavigationCollectionAction } from '../packages/cli/src/renderer/host-ui/NavigationCollectionActions.js'
import { HostRoomCompositeAvatar } from '../packages/cli/src/renderer/host-ui/conversation/RoomCompositeAvatar.js'
import {
  AgentConversationCommandController,
  type AgentConversationCommandRequest,
} from '../packages/cli/src/renderer/host-ui/conversation/commands.js'
import {
  type AgentConversationMessage,
  type AgentConversationModel,
  createAgentConversationModel,
} from '../packages/cli/src/renderer/host-ui/conversation/model.js'
import {
  createPlaygroundConversationFixture,
  playgroundConversationCopy,
} from '../packages/cli/src/playground/client/fixtures/agent-conversation.js'

interface RenderHarness {
  readonly dom: JSDOM
  readonly root: Root
  close(): Promise<void>
}

const previousGlobals = new Map<string, unknown>()

async function render(
  model: AgentConversationModel,
  commands: AgentConversationCommandController,
  debugFixture = false,
  options: Pick<AgentConversationRendererProps, 'identity' | 'navigationActions' | 'roomSettings'> = {},
): Promise<RenderHarness> {
  const dom = new JSDOM(
    '<!doctype html><html lang="zh-CN" data-theme="dark"><body><div id="root"></div></body></html>',
    { url: 'https://host.invalid/' },
  )
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  })
  Object.defineProperty(dom.window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
  })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', {
    configurable: true,
    value: (handle: number) => dom.window.clearTimeout(handle),
  })
  const globals = {
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(globals)) {
    if (!previousGlobals.has(key)) previousGlobals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value() {} },
    detachEvent: { configurable: true, value() {} },
  })
  const root = createRoot(dom.window.document.getElementById('root')!)
  await act(async () =>
    root.render(
      <AgentConversationRenderer
        model={model}
        commands={commands}
        copy={playgroundConversationCopy('zh-CN')}
        debugFixture={debugFixture}
        {...options}
      />,
    )
  )
  return {
    dom,
    root,
    async close() {
      await act(async () => root.unmount())
      dom.window.close()
    },
  }
}

afterEach(() => {
  for (const [key, value] of previousGlobals) Reflect.set(globalThis, key, value)
  previousGlobals.clear()
})

describe('AgentConversation renderer model', () => {
  it('opens an exact persisted Entity avatar after restart with no live Agent or Session', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'entity-identity-restart-'))
    let harness: RenderHarness | undefined
    try {
      const base = createPlaygroundConversationFixture('conversation', 'en')
      if (base.selection.kind !== 'room') throw new Error('Room fixture unavailable')
      const agent = base.selection.participants.find(value => value.role === 'agent')!
      const message = base.entries.find(value => value.kind === 'message' && value.authorId === agent.id)!
      const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: agent.id })
      const entityText = JSON.stringify({
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json',
        contract: 'cordisx.entity-file/v1',
        schemaVersion: 1,
        agentId: agent.id,
        name: 'Persisted Entity',
        avatar,
        inherit: {
          promptSections: 'none',
          rules: 'none',
          skills: 'none',
          tools: 'none',
          mcpServers: 'none',
          runtimeDefaults: 'none',
        },
        promptSections: [{
          sectionId: 'intro',
          kind: 'introduction',
          source: { kind: 'markdown', path: './prompts/intro.md' },
        }],
      })
      const promptFiles = [{ path: './prompts/intro.md' as const, text: 'Persisted Entity introduction.' }]
      const declaration = {
        agentId: agent.id,
        entityPath: `./entities/${agent.id}/entity.json` as const,
        digest: entityTreeDigest(entityText, promptFiles),
      }
      const binding = {
        profileId: 'identity-test',
        pluginId: 'chatroom',
        installationId: entityInstallationId('identity-test', 'chatroom'),
        pluginGeneration: 1,
      }
      const writer = new EntityDirectoryAuthority(home, 'identity-test')
      writer.register(binding, [declaration])
      expect(
        await writer.materialize(binding, '1.0.0', `sha256:${'1'.repeat(64)}`, [{
          declaration,
          entityText,
          promptFiles,
        }]),
      ).toMatchObject([{ status: 'materialized' }])
      const restarted = new EntityDirectoryAuthority(home, 'identity-test')
      const snapshot = await restarted.snapshot({ ...binding, pluginGeneration: 2 })
      const entity = snapshot.entities[0]!
      const openDetail = vi.fn(async () => undefined)
      const model = createAgentConversationModel({
        ...base,
        selection: {
          ...base.selection,
          participants: [{ ...agent, avatar, agentIdentity: entity.identity }],
          activeRuns: [],
          associatedSessions: [{
            participantId: agent.id,
            memberId: 'original-member',
            runId: 'original-run',
            sessionId: 'cx-session.original',
            state: 'unloaded',
            details: { kind: 'host', ref: 'opaque-original' },
          }],
        },
        entries: [message],
        headerActions: [],
      })
      const resolver = vi.fn(createEntityAwareIdentityResolver({
        session: () => undefined,
        agentLoop: () => undefined,
        entitySnapshot: ownerId => ownerId === model.ownerId ? snapshot : undefined,
      }))
      harness = await render(model, new AgentConversationCommandController({ execute: vi.fn() }, model), false, {
        identity: {
          resolve: resolver,
          openDetail,
          navigator: new HostAgentTaskDetailsNavigator({ navigateHost: vi.fn(), navigateExternal: vi.fn() }),
          onSettings: vi.fn(),
        },
      })
      const button = harness.dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')
      expect(button).not.toBeNull()
      await act(async () => {
        button!.click()
        await Promise.resolve()
      })
      expect(resolver).toHaveBeenCalledWith(entity.identity, model.ownerId)
      expect(harness.dom.window.document.querySelector('.cx-agent-identity-body')?.textContent).toContain(
        'Persisted Entity introduction.',
      )
      expect(harness.dom.window.document.querySelector('.cx-conversation-inspector-breadcrumb-current')?.textContent)
        .toBe('Persisted Entity')
      const row = harness.dom.window.document.querySelector<HTMLButtonElement>('.cx-agent-identity-session')!
      expect(row.textContent).toContain('Persisted Entity')
      expect(row.textContent).not.toContain('cx-session.original')
      expect(row.textContent).not.toMatch(/Not loaded|未加载|未知/)
      expect(harness.dom.window.document.querySelector('.cx-agent-identity-empty')).toBeNull()
      await act(async () => {
        row.click()
        await Promise.resolve()
      })
      expect(openDetail).toHaveBeenCalledWith(model.ownerId, { kind: 'host', ref: 'opaque-original' })
      expect(entityDefinitionPresentation(snapshot, { ...entity.identity, revision: 'unknown' })).toBeUndefined()
      expect(
        entityDefinitionPresentation(
          { ...snapshot, binding: { ...snapshot.binding, pluginId: 'foreign' } },
          entity.identity,
        ),
      ).toBeUndefined()
    } finally {
      await harness?.close()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('renders Host semantic icons without changing avatar or message context-menu labels and order', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const agent = base.selection.kind === 'room'
      ? base.selection.participants.find(participant => participant.role === 'agent')!
      : undefined
    const message = base.entries.find(entry => entry.kind === 'message' && entry.authorId === agent?.id)!
    const model = createAgentConversationModel({
      ...base,
      selection: base.selection.kind !== 'room' ? base.selection : {
        ...base.selection,
        participants: base.selection.participants.map(participant =>
          participant.id === agent?.id
            ? {
              ...participant,
              avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: participant.id }),
              agentIdentity: { agentId: participant.id, revision: 'context-menu-v1' },
            }
            : participant
        ),
      },
      entries: [message],
    })
    const harness = await render(
      model,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
      false,
      {
        identity: {
          resolve: identity => ({ identity, name: agent!.name, introduction: 'Exact identity presentation.' }),
          navigator: new HostAgentTaskDetailsNavigator({ navigateHost: vi.fn(), navigateExternal: vi.fn() }),
          onSettings: vi.fn(),
        },
      },
    )
    try {
      const document = harness.dom.window.document
      const contextMenu = async (target: HTMLElement): Promise<HTMLDivElement> => {
        await act(async () => {
          target.dispatchEvent(
            new harness.dom.window.MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: 24,
              clientY: 24,
            }),
          )
        })
        return document.querySelector<HTMLDivElement>('.cxa-context-menu')!
      }
      const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>('.cxa-context-menu-item')]
      const messageMenu = await contextMenu(document.querySelector<HTMLElement>('.cxa-message-surface')!)
      expect(items(messageMenu).map(item => item.textContent)).toEqual([
        '复制消息',
        `@提及 ${agent?.name}`,
        `查看 ${agent?.name}`,
      ])
      expect(items(messageMenu).map(item => item.querySelector<HTMLElement>('.cordisx-host-icon')?.dataset.hostIcon))
        .toEqual([
          'host:copy',
          'host:chat',
          'host:people-search',
        ])

      await act(async () => {
        document.dispatchEvent(new harness.dom.window.MouseEvent('pointerdown', { bubbles: true }))
      })
      const avatarMenu = await contextMenu(document.querySelector<HTMLElement>('.cx-agent-identity-avatar-button')!)
      expect(items(avatarMenu).map(item => item.textContent)).toEqual([
        `@提及 ${agent?.name}`,
        `查看 ${agent?.name}`,
      ])
      expect(items(avatarMenu).map(item => item.querySelector<HTMLElement>('.cordisx-host-icon')?.dataset.hostIcon))
        .toEqual([
          'host:chat',
          'host:people-search',
        ])
      expect(avatarMenu.querySelector<HTMLButtonElement>('.cxa-context-menu-item')).toBe(document.activeElement)
      const styles = document.querySelector<HTMLStyleElement>('style[data-agent-conversation-styles="production"]')!
        .textContent!
      expect(styles).toContain('.cxa-context-menu-item{appearance:none;display:flex')
      expect(styles).toContain('.cxa-context-menu-item .cordisx-host-icon{width:15px;height:15px;flex:0 0 15px')
    } finally {
      await harness.close()
    }
  })

  it('uses opposite transparent rows with an outer circular Agent avatar and one content-sized incoming surface', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const firstAgent = base.entries.find(entry => entry.kind === 'message' && entry.authorId === 'agent-alpha')!
    const model = createAgentConversationModel({
      ...base,
      entries: base.entries.map(entry =>
        entry === firstAgent
          ? {
            ...entry,
            source: 'chatroom-acknowledgement' as const,
            body: ['I will take a look.\nA long second line remains inside the same bubble.'],
          }
          : entry
      ),
    })
    const harness = await render(
      model,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
    )
    try {
      const agent = harness.dom.window.document.querySelector<HTMLElement>('.cxa-message[data-role="agent"]')!
      const outgoing = harness.dom.window.document.querySelector<HTMLElement>('.cxa-message[data-role="human"]')!
      expect(agent.querySelector('.cxa-message-avatar-seat .cxa-avatar')).not.toBeNull()
      expect(
        agent.querySelector(
          '.cxa-message-content > .cxa-message-meta + .cxa-message-bubble-row > .cxa-message-avatar-seat + .cxa-message-bubble-shell .cxa-message-surface',
        ),
      ).not.toBeNull()
      expect(agent.querySelector('.cxa-message-surface')?.textContent).toContain('A long second line')
      for (const state of agent.querySelectorAll('.cxa-message-state')) {
        expect(state.closest('.cxa-message-surface')).not.toBeNull()
      }
      expect(
        outgoing.querySelector(
          '.cxa-message-content > .cxa-message-bubble-row .cxa-message-time + .cxa-message-surface',
        ),
      ).not.toBeNull()
      expect(harness.dom.window.getComputedStyle(agent).backgroundColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/)
      const styles = harness.dom.window.document.querySelector<HTMLStyleElement>(
        'style[data-agent-conversation-styles]',
      )!.textContent!
      expect(styles).toContain('.cxa-message-content{position:relative;width:fit-content;gap:3px}')
      expect(styles).toContain(
        '.cxa-message[data-role="agent"] .cxa-message-content{max-width:min(88%,calc(720px + var(--cxa-message-avatar-size) + var(--cxa-message-avatar-gap)));justify-items:start}',
      )
      expect(styles).toContain('.cxa-message[data-role="human"] .cxa-message-surface')
      expect(styles).toContain('padding:var(--cxa-message-bubble-padding-block) 13px')
      expect(styles).toContain(
        'width:fit-content;min-width:0;max-width:100%;min-height:var(--cxa-message-avatar-size);gap:7px',
      )
      expect(styles).toContain('border-radius:15px 15px 15px 4px')
    } finally {
      await harness.close()
    }
  })

  it('projects exact participant order into 0/1/2/3/4/7 composite avatars and opens the shared members inspector', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const room = base.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>
    for (const count of [0, 1, 2, 3, 4, 7]) {
      const participants = Array.from({ length: count }, (_, index) => ({
        id: `agent-${index}`,
        role: 'agent' as const,
        name: `Agent ${index}`,
        avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: `agent-${index}` }),
      }))
      const model = createAgentConversationModel({
        ...base,
        selection: { ...room, roomId: `room-${count}`, participants },
        entries: [],
        headerActions: [],
      })
      const harness = await render(
        model,
        new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
      )
      try {
        const projection = createHostRoomCompositeAvatarProjection(participants.map(participant => ({
          participantId: participant.id,
          avatar: participant.avatar,
        })))
        expect(projection.participants.map(participant => participant.participantId)).toEqual(
          participants.map(participant => participant.id),
        )
        expect(projection.visible.map(participant => participant.participantId)).toEqual(
          participants.slice(0, count >= 4 ? 3 : count).map(participant => participant.id),
        )
        const composite = harness.dom.window.document.querySelector<HTMLElement>('.cxrv-composite')!
        expect(composite.dataset.roomCompositeCount).toBe(String(count))
        expect(composite.dataset.roomCompositeCategory).toBe(count >= 4 ? '4+' : String(count))
        expect(composite.querySelectorAll('.cxrv-participant')).toHaveLength(count >= 4 ? 3 : count)
        expect(
          [...composite.querySelectorAll('.cxrv-participant')].every(cell =>
            cell.firstElementChild?.classList.contains('cxa-avatar')
          ),
        ).toBe(true)
        expect(harness.dom.window.document.querySelector('.cxa-room-avatar-more')?.textContent ?? '').toBe(
          count >= 4 ? `+${count - 3}` : '',
        )
        const button = harness.dom.window.document.querySelector<HTMLButtonElement>('.cxa-room-avatar-button')!
        const beforeFocus = harness.dom.window.getComputedStyle(button)
        expect(beforeFocus.backgroundColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/)
        expect(beforeFocus.borderTopWidth).toBe('0px')
        expect(beforeFocus.paddingTop).toBe('0px')
        expect(beforeFocus.boxShadow).toBe('none')
        const sizeBeforeFocus = [beforeFocus.width, beforeFocus.height]
        button.focus()
        const afterFocus = harness.dom.window.getComputedStyle(button)
        expect([afterFocus.width, afterFocus.height]).toEqual(sizeBeforeFocus)
        if (count === 7) {
          const styles = harness.dom.window.document.querySelector<HTMLStyleElement>(
            'style[data-agent-conversation-styles]',
          )!.textContent!
          expect(styles).toContain(
            '.cxa-room-avatar-more{appearance:none;position:absolute;right:1px;bottom:0;z-index:2',
          )
        }
        const opener = count >= 4
          ? harness.dom.window.document.querySelector<HTMLButtonElement>('.cxa-room-avatar-more')!
          : harness.dom.window.document.querySelector<HTMLButtonElement>('.cxa-room-avatar-button')!
        await act(async () => opener.click())
        expect(harness.dom.window.document.querySelector('[data-host-conversation-inspector="true"]')).not.toBeNull()
        expect(harness.dom.window.document.querySelectorAll('.cxa-member-button')).toHaveLength(count)
      } finally {
        await harness.close()
      }
    }
    const mixedParticipants = [
      { id: 'without-a', role: 'agent' as const, name: 'Without A' },
      {
        id: 'with-b',
        role: 'agent' as const,
        name: 'With B',
        avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'with-b' }),
      },
      { id: 'without-c', role: 'human' as const, name: 'Without C' },
      {
        id: 'with-d',
        role: 'agent' as const,
        name: 'With D',
        avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'with-d' }),
      },
    ]
    const mixed = createAgentConversationModel({
      ...base,
      selection: { ...room, roomId: 'room-mixed', participants: mixedParticipants },
      entries: [],
      headerActions: [],
    })
    const mixedHarness = await render(
      mixed,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, mixed),
    )
    try {
      const projection = createHostRoomCompositeAvatarProjection(mixedParticipants.map(participant => ({
        participantId: participant.id,
        ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
      })))
      expect(projection.participants.map(participant => participant.participantId)).toEqual(['with-b', 'with-d'])
      const composite = mixedHarness.dom.window.document.querySelector<HTMLElement>('.cxrv-composite')!
      expect(composite.dataset.roomCompositeCount).toBe('2')
      expect(composite.dataset.roomCompositeCategory).toBe('2')
      expect(composite.querySelectorAll('.cxrv-participant')).toHaveLength(2)
      expect(mixedHarness.dom.window.document.querySelector('.cxa-room-avatar-more')).toBeNull()
    } finally {
      await mixedHarness.close()
    }
    const compact = new JSDOM(renderToString(
      <HostRoomCompositeAvatar
        participants={mixedParticipants}
        size="compact"
        label="Open compact members"
        moreLabel={count => `${count} more`}
        onOpen={() => undefined}
      />,
    )).window.document
    expect(compact.querySelector('[data-room-avatar-size="compact"]')).not.toBeNull()
    expect(compact.querySelectorAll('.cxrv-participant')).toHaveLength(2)
    expect(compact.querySelector('.cxa-room-avatar-more')).toBeNull()
  })

  it('keeps the explicit Agent avatar outside the bubble and exposes Host-owned mention, profile, and context actions', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const room = base.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>
    const agent = room.participants.find(participant => participant.role === 'agent')!
    const message = base.entries.find(entry => entry.kind === 'message' && entry.authorId === agent.id)!
    const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'explicit-agent-avatar' })
    const model = createAgentConversationModel({
      ...base,
      selection: {
        ...room,
        multiParticipant: false,
        participantPresentation: 'none',
        participants: [{ ...agent, avatar, agentIdentity: { agentId: agent.id, revision: 'explicit-avatar-v1' } }],
      },
      entries: [message],
      headerActions: [],
    })
    const harness = await render(
      model,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
      false,
      {
        identity: {
          resolve: identity => ({ identity, name: agent.name, introduction: 'Exact identity presentation.' }),
          navigator: new HostAgentTaskDetailsNavigator({ navigateHost: vi.fn(), navigateExternal: vi.fn() }),
          onSettings: vi.fn(),
        },
      },
    )
    try {
      const incoming = harness.dom.window.document.querySelector<HTMLElement>('.cxa-message[data-role="agent"]')!
      const avatarButton = incoming.querySelector<HTMLButtonElement>('.cx-agent-identity-avatar-button')!
      const authorButton = incoming.querySelector<HTMLButtonElement>('.cxa-author-button')!
      expect(avatarButton).not.toBeNull()
      expect(authorButton).not.toBeNull()
      expect(authorButton.getAttribute('aria-label')).toBe(`@提及 ${agent.name}`)
      const avatar = avatarButton.querySelector<HTMLElement>('.cxa-avatar')!
      expect(avatar).not.toBeNull()
      expect(avatar.getAttribute('data-avatar-kind')).toBe('generated')
      expect(incoming.querySelector('.cxa-message-surface')).not.toBeNull()
      expect(incoming.querySelector('.cxa-message-surface')?.contains(avatar)).toBe(false)
      await act(async () => {
        authorButton.click()
        await new Promise(resolve => harness.dom.window.setTimeout(resolve, 25))
      })
      await act(async () => {
        avatarButton.click()
        await Promise.resolve()
      })
      expect(harness.dom.window.document.querySelector('.cx-conversation-inspector-breadcrumb-current')?.textContent)
        .toBe(agent.name)
      expect(harness.dom.window.document.querySelector('.cx-agent-identity-body')).not.toBeNull()
      await act(async () => {
        avatarButton.dispatchEvent(
          new harness.dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 24, clientY: 32 }),
        )
        await Promise.resolve()
      })
      expect(harness.dom.window.document.querySelector('[role="menu"]')).not.toBeNull()
      expect([...harness.dom.window.document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent))
        .toEqual([
          `@提及 ${agent.name}`,
          `查看 ${agent.name}`,
        ])
    } finally {
      await harness.close()
    }
  })

  it('keeps the disabled attachment placeholder in exact compact and expanded Host composer geometry', async () => {
    const requests: AgentConversationCommandRequest[] = []
    const model = createAgentConversationModel({
      ...createPlaygroundConversationFixture('conversation', 'en'),
      composer: {
        availability: 'available',
        placeholder: 'Write a message',
        disabled: false,
        shortcutPolicy: 'enter',
        submit: { id: 'room.send' },
      },
    })
    const harness = await render(
      model,
      new AgentConversationCommandController({
        execute: async request => {
          requests.push(request)
        },
      }, model),
    )
    try {
      const document = harness.dom.window.document
      const composer = document.querySelector<HTMLFormElement>('.cxa-composer')!
      const footer = document.querySelector<HTMLElement>('.cxa-composer-footer')!
      const draft = document.querySelector<HTMLTextAreaElement>('.cxa-draft')!
      const attachment = document.querySelector<HTMLButtonElement>('.cxa-attachment-placeholder')!
      const notice = document.querySelector<HTMLElement>('.cxa-composer-notice')!
      const send = document.querySelector<HTMLButtonElement>('.cxa-send')!
      expect([...footer.children]).toEqual([attachment, notice, send])
      expect(attachment.disabled).toBe(true)
      expect(attachment.type).toBe('button')
      expect(attachment.dataset.hostComposerAttachment).toBe('unavailable')
      expect(attachment.getAttribute('aria-label')).toBe('添加附件（暂不可用）')
      expect(attachment.title).toBe('添加附件（暂不可用）')
      expect(attachment.querySelector('[data-host-icon="host:new"][data-host-icon-key="action.add"]')).not.toBeNull()

      const valueSetter = Object.getOwnPropertyDescriptor(harness.dom.window.HTMLTextAreaElement.prototype, 'value')
        ?.set
      await act(async () => {
        valueSetter?.call(draft, 'one line')
        draft.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }))
        await Promise.resolve()
      })
      draft.focus()
      draft.setSelectionRange(2, 6)
      composer.dataset.cordisxShikitorLayout = 'compact'
      const residentDraft = draft
      const residentAttachment = attachment
      composer.style.width = '280px'
      document.documentElement.dataset.theme = 'light'
      composer.dataset.cordisxShikitorLayout = 'expanded'
      document.documentElement.dataset.theme = 'dark'
      attachment.click()
      expect(document.querySelector('.cxa-draft')).toBe(residentDraft)
      expect(document.querySelector('.cxa-attachment-placeholder')).toBe(residentAttachment)
      expect(document.activeElement).toBe(draft)
      expect(draft.value).toBe('one line')
      expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 6])
      expect(requests).toHaveLength(0)

      const [styles, shikitor] = await Promise.all([
        readFile(path.resolve('packages/cli/src/renderer/host-ui/conversation/styles.ts'), 'utf8'),
        readFile(path.resolve('packages/cli/src/renderer/host-ui/conversation/ShikitorComposerAdapter.ts'), 'utf8'),
      ])
      expect(styles).toContain(
        '.cxa-attachment-placeholder{appearance:none;display:inline-grid;width:30px;height:30px;min-height:30px;flex:none',
      )
      expect(styles).toContain('border:1px solid var(--cx-border)')
      expect(styles).toContain('background:transparent;color:var(--cx-muted)')
      expect(shikitor).toContain('grid-template-columns:auto minmax(0,1fr) auto')
      expect(shikitor).toContain('>.cxa-draft{grid-column:2;grid-row:1;align-self:center}')
      expect(shikitor).toContain('>.cxa-attachment-placeholder{grid-column:1;grid-row:1;align-self:center}')
      expect(shikitor).toContain('>.cxa-send{grid-column:3;grid-row:1;align-self:center}')
      expect(shikitor).toContain(
        '[data-cordisx-shikitor-layout="expanded"]>.cxa-composer-footer{grid-column:1;grid-row:2}',
      )
      expect(shikitor).toContain('>.shikitor.shikitor--attached{inset:8px 46px auto;width:auto;height:30px}')
      expect(shikitor).toContain('COMPACT_COLUMN_GAP * 2 - attachmentWidth - sendWidth')
      expect(shikitor).toContain('data-cordisx-shikitor-native-text="true"')
      expect(shikitor).toContain("dataset.shikitorRenderMode === 'less-dom'")
      expect(shikitor).toContain(
        'color:var(--cx-text)!important;-webkit-text-fill-color:var(--cx-text)!important;caret-color:var(--cx-text)!important',
      )
      expect(shikitor).toContain('::placeholder{color:var(--cx-muted)!important')
      expect(shikitor).toContain(
        'data-cordisx-shikitor-native-text="true"]:not([data-cordisx-shikitor-fallback]){color:CanvasText!important',
      )
    } finally {
      await harness.close()
    }
  })
  it('groups adjacent Agent messages by exact participant identity: first name, last avatar, and accessible bubble time', async () => {
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const room = base.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>
    const lead = {
      id: 'lead',
      role: 'agent' as const,
      name: 'Lead',
      avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' }),
      agentIdentity: { agentId: 'lead', revision: 'r1' },
    }
    const reviewer = {
      id: 'reviewer',
      role: 'agent' as const,
      name: 'Reviewer',
      avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'reviewer' }),
      agentIdentity: { agentId: 'reviewer', revision: 'r1' },
    }
    const human = { id: 'human', role: 'human' as const, name: 'You' }
    const system = { id: 'system', role: 'system' as const, name: 'System' }
    const entry = (
      itemId: string,
      authorId: string,
      sequence: number,
      text: string,
      semantic?: AgentConversationMessage['semantic'],
    ) => ({
      kind: 'message' as const,
      itemId,
      messageId: `message-${itemId}`,
      sequence,
      authorId,
      body: [text],
      timestamp: `2026-08-31T00:00:0${sequence}.000Z`,
      deliveryState: 'delivered' as const,
      runState: 'idle' as const,
      ariaLive: 'off' as const,
      actions: [],
      source: 'agent-loop' as const,
      reactions: [],
      ...(semantic === undefined ? {} : { semantic }),
    })
    const model = createAgentConversationModel({
      ...base,
      selection: { ...room, roomId: 'grouped', participants: [lead, reviewer, human, system] },
      entries: [
        entry('lead-introduction', 'lead', 1, 'I am Lead.', {
          purpose: 'member-self-introduction',
          causation: { operationId: 'intro' },
          participantId: 'lead',
          memberId: 'lead',
          runId: 'lead-run',
          binding: { bindingId: 'lead-binding', generation: 1 },
          turn: 'lead-turn',
        }),
        entry('lead-reply', 'lead', 2, 'I will continue.', { purpose: 'conversation' }),
        entry('human-break', 'human', 3, 'Please continue.', { purpose: 'conversation' }),
        entry('lead-after-human', 'lead', 4, 'Continuing.', { purpose: 'conversation' }),
        entry('system-break', 'system', 5, 'System event.', { purpose: 'conversation' }),
        entry('reviewer-reply', 'reviewer', 6, 'Reviewing.', { purpose: 'conversation' }),
      ],
      headerActions: [],
    })
    const harness = await render(
      model,
      new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model),
      false,
      {
        identity: {
          resolve: identity => ({
            identity,
            name: identity.agentId === 'lead' ? 'Lead' : 'Reviewer',
            introduction: 'Exact identity presentation.',
          }),
          navigator: new HostAgentTaskDetailsNavigator({ navigateHost: vi.fn(), navigateExternal: vi.fn() }),
          onSettings: vi.fn(),
        },
      },
    )
    try {
      const document = harness.dom.window.document
      const intro = document.querySelector<HTMLElement>('[data-entry-id="lead-introduction"]')!
      const followup = document.querySelector<HTMLElement>('[data-entry-id="lead-reply"]')!
      const afterHuman = document.querySelector<HTMLElement>('[data-entry-id="lead-after-human"]')!
      const reviewerReply = document.querySelector<HTMLElement>('[data-entry-id="reviewer-reply"]')!
      expect([intro, followup, afterHuman, reviewerReply].map(node => [node.dataset.groupStart, node.dataset.groupEnd]))
        .toEqual([
          ['true', 'false'],
          ['false', 'true'],
          ['true', 'true'],
          ['true', 'true'],
        ])
      expect(intro.querySelector('.cx-agent-identity-avatar-button')).toBeNull()
      expect(followup.querySelector('.cx-agent-identity-avatar-button')).not.toBeNull()
      expect(afterHuman.querySelector('.cx-agent-identity-avatar-button')).not.toBeNull()
      expect(reviewerReply.querySelector('.cx-agent-identity-avatar-button')).not.toBeNull()
      expect(intro.querySelector('.cxa-message-meta')?.textContent).toContain('Lead')
      expect(followup.querySelector('.cxa-message-meta')).not.toBeNull()
      expect(followup.querySelector('.cxa-author')).toBeNull()
      expect(afterHuman.querySelector('.cxa-message-meta')?.textContent).toContain('Lead')
      expect(reviewerReply.querySelector('.cxa-message-meta')?.textContent).toContain('Reviewer')
      const introSeat = intro.querySelector<HTMLElement>('.cxa-message-avatar-seat')!
      const followupSeat = followup.querySelector<HTMLElement>('.cxa-message-avatar-seat')!
      expect(introSeat.dataset.avatarSeat).toBe('placeholder')
      expect(introSeat.getAttribute('aria-hidden')).toBe('true')
      expect(introSeat.hasAttribute('inert')).toBe(true)
      expect(followupSeat.dataset.avatarSeat).toBe('visible')
      expect(followupSeat.hasAttribute('aria-hidden')).toBe(false)
      expect(
        intro.querySelector(
          '.cxa-message-bubble-row > .cxa-message-avatar-seat + .cxa-message-bubble-shell .cxa-message-surface',
        ),
      ).not.toBeNull()
      expect(
        followup.querySelector(
          '.cxa-message-bubble-row > .cxa-message-avatar-seat + .cxa-message-bubble-shell .cxa-message-surface',
        ),
      ).not.toBeNull()
      for (const message of [intro, followup, afterHuman, reviewerReply]) {
        const time = message.querySelector<HTMLButtonElement>('.cxa-message-time')!
        expect(time.closest('.cxa-message-meta')).not.toBeNull()
        expect(time.closest('.cxa-message-surface')).toBeNull()
        expect(time.tabIndex).toBe(0)
        expect(time.querySelector('time')).not.toBeNull()
        expect(message.getAttribute('aria-label')).toContain(message === reviewerReply ? 'Reviewer' : 'Lead')
      }
      const styles = document.querySelector<HTMLStyleElement>('style[data-agent-conversation-styles]')!.textContent!
      expect(styles).toContain(
        '.cxa-message-bubble-row{display:flex;min-width:0;max-width:100%;align-items:stretch;gap:var(--cxa-message-avatar-gap)}',
      )
      expect(styles).toContain(
        '.cxa-message-avatar-seat{display:grid;width:var(--cxa-message-avatar-size);min-height:var(--cxa-message-avatar-size);height:auto;flex:0 0 var(--cxa-message-avatar-size)',
      )
      expect(styles).toContain(
        '.cxa-message[data-role="agent"] .cxa-message-meta{max-width:calc(100% - var(--cxa-message-avatar-size) - var(--cxa-message-avatar-gap));margin-inline-start:calc(var(--cxa-message-avatar-size) + var(--cxa-message-avatar-gap));padding-inline:0}',
      )
      expect(styles).toContain(
        '--cxa-message-avatar-size:calc(var(--cxa-message-line-height) + var(--cxa-message-bubble-padding-block) + var(--cxa-message-bubble-padding-block) + var(--cxa-message-bubble-border-width) + var(--cxa-message-bubble-border-width))',
      )
      expect(styles).toContain(
        '.cxa-message[data-role="agent"] .cxa-message-content:has(>.cxa-message-bubble-row>.cxa-message-bubble-shell>.cxa-message-bubble-anchor:hover)>.cxa-message-meta>.cxa-message-time',
      )
      expect(styles).toContain(
        '.cxa-message-time{display:inline-flex;flex:none;align-items:center;padding:0;border:0;opacity:0',
      )
      expect(styles).not.toContain('.cxa-message:hover .cxa-message-time')
    } finally {
      await harness.close()
    }
  })
})
