import { cloneAgentAvatarRef, createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { createHash } from 'node:crypto'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentConversationRenderer } from '../packages/cli/src/renderer/host-ui/conversation/AgentConversationRenderer.js'
import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'
import { AgentConversationCommandController } from '../packages/cli/src/renderer/host-ui/conversation/commands.js'
import { createAgentConversationModel, type AgentConversationModel } from '../packages/cli/src/renderer/host-ui/conversation/model.js'
import {
  createPlaygroundConversationFixture,
  playgroundConversationCopy,
} from '../packages/cli/src/playground/client/fixtures/agent-conversation.js'

const avatarRenderSpy = vi.hoisted(() => vi.fn())
const avatarDefinitionRegistry = vi.hoisted(() => ({ values: [] as unknown[] }))
vi.mock('@oneworks/avatar-react/style.css', () => ({
  default: '.oneworks-avatar,.oneworks-avatar-editor{box-sizing:border-box}.oneworks-avatar *,.oneworks-avatar-editor *{box-sizing:border-box}.oneworks-avatar{position:relative;display:block;width:100%;height:100%}.oneworks-avatar[data-frame=rounded]{border-radius:12.5%}.oneworks-avatar[data-frame=circle]{border-radius:50%}.oneworks-avatar>.interactive-avatar{width:100%;height:100%}',
}))
vi.mock('@oneworks/avatar-react', () => ({
  Avatar: ({ className, definition, theme, interactive, autoplay, onError }: {
    className?: string
    definition?: unknown
    theme?: string
    interactive?: boolean
    autoplay?: boolean
    onError?: (error: Error) => void
  }) => {
    let definitionIndex = avatarDefinitionRegistry.values.indexOf(definition)
    if (definitionIndex < 0) definitionIndex = avatarDefinitionRegistry.values.push(definition) - 1
    avatarRenderSpy({ definition, theme, interactive, autoplay })
    return <span
    tabIndex={-1}
    className={`oneworks-avatar ${className ?? ''}`}
    data-renderer-theme={theme}
    data-renderer-interactive={String(interactive)}
    data-renderer-autoplay={String(autoplay)}
    data-renderer-profile={(definition as { metadata?: { generation?: { profileId?: string } } } | undefined)?.metadata?.generation?.profileId}
    data-renderer-preset={(definition as { scene?: { entity?: { preset?: string } } } | undefined)?.scene?.entity?.preset}
    data-renderer-definition-token={String(definitionIndex)}
    onClick={() => onError?.(new Error('renderer failed'))}
    />
  },
}))

import {
  HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF,
  HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REVISION,
  HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF,
  HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION,
  HostAgentAvatar,
  HostAgentAvatarResolver,
} from '../packages/cli/src/renderer/host-ui/conversation/AgentAvatar.js'
import {
  HOST_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REF,
  HOST_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REVISION,
  HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REF,
  HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REVISION,
  HOST_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REF,
  HOST_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REVISION,
  OFFICIAL_ONEWORKS_AVATAR_ASSET_PROVENANCE,
} from '../packages/cli/src/renderer/host-ui/conversation/OfficialOneWorksAvatarAssets.js'

const previousGlobals = new Map<string, unknown>()

const OFFICIAL_ANIMAL_ASSETS = [
  {
    ref: HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF,
    revision: HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION,
    profileId: 'red-fox',
    preset: 'fox',
    canonicalDefinitionSha256: 'e4df5d748767718eeed6cdc77b3ab0cbe10441adf3cf713d3a9e126c3527d0d9',
  },
  {
    ref: HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF,
    revision: HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REVISION,
    profileId: 'arctic-fox',
    preset: 'fox',
    canonicalDefinitionSha256: '6a178492316eac13e7198581f4657bc8bd0d2259871eff762a022f4cc1594ab0',
  },
  {
    ref: HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REF,
    revision: HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REVISION,
    profileId: 'syrian-hamster',
    preset: 'hamster',
    canonicalDefinitionSha256: '5eebb3ea9c0131005fd336e7c8494c74fce92903373272632da940f22307c1f7',
  },
  {
    ref: HOST_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REF,
    revision: HOST_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REVISION,
    profileId: 'asian-small-clawed-otter',
    preset: 'otter',
    canonicalDefinitionSha256: '4ceef0184bd3d2fd6a469b20decf1d0dd3cd726bbeaf3d07c43389ba5b2bab6f',
  },
  {
    ref: HOST_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REF,
    revision: HOST_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REVISION,
    profileId: 'yellow-duckling',
    preset: 'duck',
    canonicalDefinitionSha256: 'a8d6820ff62d33d931b2554f6080126c2685ad84eed34a559ef7407374b447c6',
  },
] as const

function installDom(theme: 'light' | 'dark' = 'light'): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body><div id="theme" data-cordisx-app-theme="${theme}"><div id="root"></div></div></body></html>`)
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
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  })
  for (const [key, value] of Object.entries({
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    HTMLCanvasElement: dom.window.HTMLCanvasElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previousGlobals.set(key, Reflect.get(globalThis, key))
    Reflect.set(globalThis, key, value)
  }
  return dom
}

afterEach(() => {
  for (const [key, value] of previousGlobals) Reflect.set(globalThis, key, value)
  previousGlobals.clear()
  avatarRenderSpy.mockClear()
  avatarDefinitionRegistry.values.length = 0
})

describe('Host Agent avatar resolver', () => {
  it('pins the formal Protocol and exact OneWorks RC.8 packages and consumes the exported CSS as Host-scoped text', async () => {
    const [rootPackage, cliPackage, lock, avatarSource, styles] = await Promise.all([
      readFile('package.json', 'utf8').then(JSON.parse),
      readFile('packages/cli/package.json', 'utf8').then(JSON.parse),
      readFile('package-lock.json', 'utf8').then(JSON.parse),
      readFile('packages/cli/src/renderer/host-ui/conversation/AgentAvatar.tsx', 'utf8'),
      readFile('packages/cli/src/renderer/host-ui/conversation/styles.ts', 'utf8'),
    ])
    const protocol = 'github:cordisx/cordisx-protocol#df6caacaf7f538b6e0fe95e2dfaa30e11961fa1e'
    expect(rootPackage.devDependencies['@cordisx/protocol']).toBe(protocol)
    expect(cliPackage.dependencies).toMatchObject({
      '@cordisx/protocol': protocol,
      '@oneworks/avatar': '1.0.0-rc.8',
      '@oneworks/avatar-react': '1.0.0-rc.8',
    })
    expect(lock.packages['node_modules/@oneworks/avatar']).toMatchObject({
      version: '1.0.0-rc.8',
      integrity: 'sha512-9vKWfiPUlEfVzcO+6Q2QsCmqlINZb2CpXjN4M/JO2+v0IwqsGIcWGaxW44lf3moSQj70lEmnF6F7bZofw7mcXQ==',
    })
    expect(lock.packages['node_modules/@oneworks/avatar-react']).toMatchObject({
      version: '1.0.0-rc.8',
      integrity: 'sha512-fJ+p2LLG5tb3YV5QAAm/3gnkEFuCfMSR/WttpvMv8xNp64Ou6TB4Tz5QE6LqOwgT7q67qrBluZMwDfQUjX++aw==',
      dependencies: { '@oneworks/avatar': '1.0.0-rc.8' },
    })
    expect(avatarSource).toContain("import avatarVendorCss from '@oneworks/avatar-react/style.css'")
    expect(avatarSource).toContain('data-cordisx-agent-avatar-style')
    expect(avatarSource).not.toContain('createDefaultAvatarDefinition')
    expect(avatarSource).not.toContain('createOneWorksFoxDefinition')
    expect(avatarSource).not.toContain('red-fox-v1')
    expect(avatarSource).not.toContain('process.env')
    expect(styles).not.toContain('.cxa-avatar .oneworks-avatar *')
    const reducedMotionRule = styles.match(/@media \(prefers-reduced-motion:reduce\)\{[^\n]+/)?.[0] ?? ''
    expect(reducedMotionRule).toContain('.cxa-avatar *')
    expect(reducedMotionRule).toContain('animation:none!important;transition:none!important')
  })

  it('creates deterministic OneWorks definitions and keeps a bounded LRU cache', () => {
    const resolver = new HostAgentAvatarResolver(2)
    const lead = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' })
    const reviewer = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'reviewer' })
    const writer = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'writer' })
    const first = resolver.resolve(lead)
    expect(first.status).toBe('resolved')
    expect(resolver.resolve(lead)).toBe(first)
    expect(resolver.resolve(reviewer).status).toBe('resolved')
    expect(resolver.resolve(writer).status).toBe('resolved')
    expect(resolver.size).toBe(2)
    expect(resolver.resolve(lead)).not.toBe(first)
  })

  it('uses canonical identity goldens and caches only validated frozen generated definitions', () => {
    const resolver = new HostAgentAvatarResolver()
    const refs = [
      createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'Lead' }),
      createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'reviewer' }),
      createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'Ångent' }),
      createGeneratedAgentAvatarRef({ namespace: 'unknown' }),
    ] as const
    expect(refs.map(ref => ref.seed)).toEqual([
      'cordisx.agent-avatar.seed/v1:agent-definition:4:Lead',
      'cordisx.agent-avatar.seed/v1:agent-definition:8:reviewer',
      'cordisx.agent-avatar.seed/v1:agent-definition:7:Ångent',
      'cordisx.agent-avatar.seed/v1:unknown:0:',
    ])
    for (const ref of refs) {
      const result = resolver.resolve(ref)
      expect(result.status).toBe('resolved')
      if (result.status === 'resolved') expect(Object.isFrozen(result.definition)).toBe(true)
    }
    expect(resolver.size).toBe(4)
  })

  it('resolves exact official OneWorks breed exports through opaque asset refs', () => {
    const resolver = new HostAgentAvatarResolver()
    for (const [ref, revision, profileId, paletteId, canonicalDefinitionSha256] of [
      [HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF, HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION, 'red-fox', 'red-fox', 'e4df5d748767718eeed6cdc77b3ab0cbe10441adf3cf713d3a9e126c3527d0d9'],
      [HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF, HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REVISION, 'arctic-fox', 'arctic-fox', '6a178492316eac13e7198581f4657bc8bd0d2259871eff762a022f4cc1594ab0'],
    ] as const) {
      const avatar = cloneAgentAvatarRef({
        kind: 'asset', ref, revision,
      })
      const result = resolver.resolve(avatar)
      expect(result.status).toBe('resolved')
      if (result.status !== 'resolved') continue
      expect(result.avatar).toEqual(avatar)
      expect(result.definition).toMatchObject({
        schema: 'oneworks.avatar', version: 1,
        scene: {
          appearance: { paletteId },
          camera: { frame: 'rounded' },
          entity: { preset: 'fox' },
          face: { mouthEnabled: false, noseEnabled: true, noseShape: 'inverted-triangle' },
        },
      })
      expect(result.definition.metadata?.generation).toMatchObject({ profileId, fields: [] })
      expect(result.definition.scene.entity.parts.map(part => part.id)).toEqual([
        'fox-ear-left', 'fox-ear-right', 'fox-head',
      ])
      expect(result.definition.scene.decals.map(decal => decal.id)).toEqual([
        'fox-inner-ear-left', 'fox-inner-ear-right', 'fox-cheek-left', 'fox-cheek-right',
      ])
      expect(result.definition.scene.view).toMatchObject({ scale: 1.7697 })
      expect(result.definition.scene.entity.preset).not.toBe('custom')
      expect(createHash('sha256').update(JSON.stringify(result.definition)).digest('hex')).toBe(canonicalDefinitionSha256)
      expect(resolver.resolve(avatar)).toBe(result)
    }
    expect(OFFICIAL_ONEWORKS_AVATAR_ASSET_PROVENANCE).toEqual({
      source: 'https://oneworks.cloud/avatar/',
      renderer: '@oneworks/avatar-react@1.0.0-rc.8',
      definitions: {
        [HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF]: {
          profileId: 'red-fox',
          capturedExportSha256: '2b30c25a3fcd29bf349fed927df85f1ba4b0a6096a9dfc1d2d1088e05654d8aa',
          canonicalDefinitionSha256: 'e4df5d748767718eeed6cdc77b3ab0cbe10441adf3cf713d3a9e126c3527d0d9',
        },
        [HOST_ONEWORKS_ARCTIC_FOX_AVATAR_ASSET_REF]: {
          profileId: 'arctic-fox',
          capturedExportSha256: '2c262adc567c423a94d497bfea9c9906f2da71cdde0e0cef6d71c263ceaf3011',
          canonicalDefinitionSha256: '6a178492316eac13e7198581f4657bc8bd0d2259871eff762a022f4cc1594ab0',
        },
        [HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REF]: {
          profileId: 'syrian-hamster',
          capturedExportSha256: '5eebb3ea9c0131005fd336e7c8494c74fce92903373272632da940f22307c1f7',
          canonicalDefinitionSha256: '5eebb3ea9c0131005fd336e7c8494c74fce92903373272632da940f22307c1f7',
        },
        [HOST_ONEWORKS_ASIAN_SMALL_CLAWED_OTTER_AVATAR_ASSET_REF]: {
          profileId: 'asian-small-clawed-otter',
          capturedExportSha256: '4ceef0184bd3d2fd6a469b20decf1d0dd3cd726bbeaf3d07c43389ba5b2bab6f',
          canonicalDefinitionSha256: '4ceef0184bd3d2fd6a469b20decf1d0dd3cd726bbeaf3d07c43389ba5b2bab6f',
        },
        [HOST_ONEWORKS_YELLOW_DUCKLING_AVATAR_ASSET_REF]: {
          profileId: 'yellow-duckling',
          capturedExportSha256: 'a8d6820ff62d33d931b2554f6080126c2685ad84eed34a559ef7407374b447c6',
          canonicalDefinitionSha256: 'a8d6820ff62d33d931b2554f6080126c2685ad84eed34a559ef7407374b447c6',
        },
      },
    })
  })

  it('resolves five immutable animal assets only at their exact ref and revision and keeps every definition distinct', () => {
    const resolver = new HostAgentAvatarResolver()
    const definitions = OFFICIAL_ANIMAL_ASSETS.map(asset => {
      const avatar = cloneAgentAvatarRef({ kind: 'asset', ref: asset.ref, revision: asset.revision })
      const result = resolver.resolve(avatar)
      expect(result.status).toBe('resolved')
      if (result.status !== 'resolved') throw new Error(`Official avatar ${asset.profileId} did not resolve`)
      expect(result.avatar).toEqual(avatar)
      expect(result.definition.metadata?.generation).toMatchObject({ profileId: asset.profileId, fields: [] })
      expect(result.definition.scene).toMatchObject({
        appearance: { paletteId: asset.profileId },
        camera: { frame: 'rounded', size: 256 },
        entity: { preset: asset.preset },
      })
      expect(Object.isFrozen(result.definition)).toBe(true)
      expect(createHash('sha256').update(JSON.stringify(result.definition)).digest('hex')).toBe(asset.canonicalDefinitionSha256)
      expect(resolver.resolve(avatar)).toBe(result)
      expect(resolver.resolve(cloneAgentAvatarRef({
        kind: 'asset', ref: asset.ref, revision: `${asset.revision}-unknown`,
      }))).toMatchObject({ status: 'unsupported', code: 'reference-unavailable' })
      return result.definition
    })
    expect(new Set(definitions.map(definition => JSON.stringify(definition)))).toHaveLength(5)
    expect(definitions.map(definition => definition.scene.entity.preset)).toEqual(['fox', 'fox', 'hamster', 'otter', 'duck'])
    expect(new Set(definitions.map(definition => definition.scene.appearance.paletteId))).toHaveLength(5)
    expect(Object.keys(OFFICIAL_ONEWORKS_AVATAR_ASSET_PROVENANCE.definitions)).toEqual(
      OFFICIAL_ANIMAL_ASSETS.map(asset => asset.ref),
    )
  })

  it('does not cache opaque fallbacks or failed generated definitions', () => {
    const failure = vi.fn(() => { throw new Error('definition generation failed') })
    const resolver = new HostAgentAvatarResolver(2, failure)
    const generated = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'Lead' })
    expect(() => resolver.resolve(generated)).toThrow('definition generation failed')
    expect(() => resolver.resolve(generated)).toThrow('definition generation failed')
    expect(failure).toHaveBeenCalledTimes(2)
    expect(resolver.size).toBe(0)
    resolver.resolve(cloneAgentAvatarRef({ kind: 'asset', ref: 'avatar-assets:lead' }))
    expect(resolver.size).toBe(0)
  })

  it('returns typed opaque-reference fallbacks and rejects raw media/path inputs', () => {
    const resolver = new HostAgentAvatarResolver()
    expect(resolver.resolve(cloneAgentAvatarRef({ kind: 'asset', ref: 'avatar-assets:lead' }))).toMatchObject({
      status: 'unsupported', code: 'reference-unavailable', avatar: { kind: 'asset' },
    })
    expect(resolver.resolve(cloneAgentAvatarRef({ kind: 'platform', provider: 'slack', identityRef: 'slack-user:lead' }))).toMatchObject({
      status: 'unsupported', code: 'unsupported-provider', avatar: { kind: 'platform' },
    })
    for (const unsafe of ['https://unsafe.invalid/avatar.png', 'data:image/png;base64,AAAA', '/tmp/avatar.png']) {
      expect(() => resolver.resolve({ kind: 'asset', ref: unsafe } as never)).toThrow('qualified opaque ref')
    }
  })
})

describe('Host Agent avatar renderer', () => {
  it('renders deterministic initials on the server without touching the vendor renderer', () => {
    const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'Lead' })
    const markup = renderToString(<HostAgentAvatar participant={{ id: 'lead', role: 'agent', name: 'Lead Agent', avatar }} />)
    expect(markup).toContain('data-avatar-state="fallback"')
    expect(markup).toContain('>LA<')
    expect(avatarRenderSpy).not.toHaveBeenCalled()
  })

  it('is decorative, static, theme-aware, and falls back without exposing an opaque ref', async () => {
    const dom = installDom('dark')
    const root = createRoot(dom.window.document.getElementById('root')!)
    const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead-private-identity' })
    await act(async () => root.render(<HostAgentAvatar participant={{ id: 'lead', role: 'agent', name: 'Lead Agent', avatar }} />))
    const wrapper = dom.window.document.querySelector<HTMLElement>('.cxa-avatar')!
    const renderer = dom.window.document.querySelector<HTMLElement>('.oneworks-avatar')!
    expect(wrapper.getAttribute('aria-hidden')).toBe('true')
    expect(wrapper.hasAttribute('inert')).toBe(true)
    expect(wrapper.dataset.avatarState).toBe('resolved')
    expect(renderer.dataset.rendererTheme).toBe('dark')
    expect(renderer.dataset.rendererInteractive).toBe('false')
    expect(renderer.dataset.rendererAutoplay).toBe('false')
    expect(dom.window.document.body.innerHTML).not.toContain('lead-private-identity')

    await act(async () => {
      dom.window.document.getElementById('theme')!.setAttribute('data-cordisx-app-theme', 'light')
      await Promise.resolve()
    })
    expect(renderer.dataset.rendererTheme).toBe('light')
    await act(async () => renderer.click())
    expect(wrapper.dataset.avatarState).toBe('fallback')
    expect(wrapper.textContent).toBe('LA')
    await act(async () => root.unmount())
    dom.window.close()
  })

  it('passes the exact official asset definition to the OneWorks renderer without exposing its opaque key', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    const avatar = cloneAgentAvatarRef({
      kind: 'asset',
      ref: HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF,
      revision: HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REVISION,
    })
    await act(async () => root.render(<HostAgentAvatar participant={{ id: 'lead', role: 'agent', name: 'Lead', avatar }} />))
    const wrapper = dom.window.document.querySelector<HTMLElement>('.cxa-avatar')!
    expect(wrapper.dataset.avatarState).toBe('resolved')
    expect(wrapper.dataset.avatarKind).toBe('asset')
    expect(dom.window.document.body.innerHTML).not.toContain(HOST_ONEWORKS_RED_FOX_AVATAR_ASSET_REF)
    expect(avatarRenderSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        metadata: expect.objectContaining({ generation: expect.objectContaining({ profileId: 'red-fox' }) }),
        scene: expect.objectContaining({
          appearance: expect.objectContaining({ paletteId: 'red-fox' }),
          entity: expect.objectContaining({ preset: 'fox' }),
        }),
      }),
    }))
    await act(async () => root.unmount())
    dom.window.close()
  })

  it('uses the same exact official definition in message, reaction, composite, and identity renderers', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    const asset = OFFICIAL_ANIMAL_ASSETS[2]
    const avatar = cloneAgentAvatarRef({ kind: 'asset', ref: asset.ref, revision: asset.revision })
    const base = createPlaygroundConversationFixture('conversation', 'en')
    const room = base.selection as Extract<AgentConversationModel['selection'], { kind: 'room' }>
    const sourceMessage = base.entries.find(entry => entry.kind === 'message' && entry.authorId === 'agent-alpha')!
    const participant = {
      id: 'agent-alpha',
      role: 'agent' as const,
      name: 'Agent Alpha',
      avatar,
      agentIdentity: { agentId: 'agent-alpha', revision: 'identity-r1' },
    }
    const model = createAgentConversationModel({
      ...base,
      selection: {
        ...room,
        multiParticipant: false,
        participantPresentation: 'none',
        participants: [participant],
        activeRuns: [{
          participantId: participant.id,
          memberId: 'member-alpha',
          runId: 'run-alpha',
          lifecycle: { phase: 'active' },
          detailsUrl: { url: 'app://-/tasks/agent-alpha', target: 'host' },
        }],
      },
      entries: [{
        ...sourceMessage,
        reactions: [{
          reactionId: 'reaction-alpha',
          actorParticipantId: participant.id,
          value: { kind: 'emoji' as const, emoji: '🐹' },
          state: 'completed' as const,
        }],
      }],
      headerActions: [],
    })
    const commands = new AgentConversationCommandController({ execute: vi.fn(async () => undefined) }, model)
    const identity = {
      resolve: (requested: { readonly agentId: string; readonly revision: string }) => ({
        identity: requested,
        name: 'Agent Alpha',
        introduction: 'Exact official avatar identity.',
      }),
      navigator: new HostAgentTaskDetailsNavigator({ navigateHost: vi.fn(), navigateExternal: vi.fn() }),
      onSettings: vi.fn(),
    }
    await act(async () => root.render(<AgentConversationRenderer
      model={model}
      commands={commands}
      copy={playgroundConversationCopy('en')}
      identity={identity}
    />))
    await act(async () => await Promise.resolve())

    const definitionAt = (selector: string): string => {
      const renderer = dom.window.document.querySelector<HTMLElement>(selector)
      expect(renderer, selector).not.toBeNull()
      expect(renderer?.dataset.rendererProfile).toBe(asset.profileId)
      expect(renderer?.dataset.rendererPreset).toBe(asset.preset)
      return renderer!.dataset.rendererDefinitionToken!
    }
    const definitions = [
      definitionAt('.cxa-room-avatar-button .cxa-avatar-renderer'),
      definitionAt('.cxa-message-avatar-seat .cxa-avatar-renderer'),
      definitionAt('.cxa-message-reaction-avatar .cxa-avatar-renderer'),
    ]
    expect(new Set(definitions)).toHaveLength(1)
    const renderedDefinition = avatarRenderSpy.mock.calls
      .map(([call]) => call.definition)
      .find(definition => definition?.metadata?.generation?.profileId === asset.profileId)
    expect(createHash('sha256').update(JSON.stringify(renderedDefinition)).digest('hex')).toBe(asset.canonicalDefinitionSha256)

    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('.cxa-message-avatar-seat .cx-agent-identity-avatar-button')!.click())
    const identityDefinition = definitionAt('.cx-agent-identity-avatar-seat .cxa-avatar-renderer')
    expect(identityDefinition).toBe(definitions[0])
    expect(dom.window.document.body.innerHTML).not.toContain(asset.ref)
    expect(dom.window.document.body.innerHTML).not.toContain(asset.revision)

    await act(async () => root.unmount())
    dom.window.close()
  })

  it('reference-counts one scoped upstream style marker and removes it when the Host root unmounts', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    const lead = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' })
    const reviewer = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'reviewer' })
    await act(async () => root.render(<>
      <HostAgentAvatar participant={{ id: 'lead', role: 'agent', name: 'Lead', avatar: lead }} />
      <HostAgentAvatar participant={{ id: 'reviewer', role: 'agent', name: 'Reviewer', avatar: reviewer }} />
    </>))
    const styles = dom.window.document.querySelectorAll('style[data-cordisx-agent-avatar-style="oneworks-avatar-react@1.0.0-rc.8"]')
    expect(styles).toHaveLength(1)
    expect(styles[0]!.textContent).toContain('.cxa-avatar .oneworks-avatar>.interactive-avatar')
    expect(styles[0]!.textContent).not.toContain('.oneworks-avatar-editor')
    expect(styles[0]!.dataset.cordisxAgentAvatarStyleUsers).toBe('2')
    await act(async () => root.unmount())
    expect(dom.window.document.querySelectorAll('style[data-cordisx-agent-avatar-style]')).toHaveLength(0)
    dom.window.close()
  })

  it('keeps initials when generated definition resolution fails', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    const resolver = new HostAgentAvatarResolver(2, () => { throw new Error('unavailable') })
    const avatar = createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: 'lead' })
    await act(async () => root.render(<HostAgentAvatar resolver={resolver} participant={{ id: 'lead', role: 'agent', name: 'Lead', avatar }} />))
    const wrapper = dom.window.document.querySelector<HTMLElement>('.cxa-avatar')!
    expect(wrapper.dataset.avatarState).toBe('fallback')
    expect(wrapper.textContent).toBe('LE')
    expect(avatarRenderSpy).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    dom.window.close()
  })

  it('uses initials for an unknown official asset revision and does not expose the ref or revision to DOM', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    const unknownRevision = `${HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REVISION}-unknown`
    const avatar = cloneAgentAvatarRef({
      kind: 'asset',
      ref: HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REF,
      revision: unknownRevision,
    })
    await act(async () => root.render(<HostAgentAvatar participant={{ id: 'reviewer', role: 'agent', name: 'Review Agent', avatar }} />))
    const wrapper = dom.window.document.querySelector<HTMLElement>('.cxa-avatar')!
    expect(wrapper.dataset).toMatchObject({ avatarState: 'fallback', avatarKind: 'asset', avatarCode: 'reference-unavailable' })
    expect(wrapper.textContent).toBe('RA')
    expect(avatarRenderSpy).not.toHaveBeenCalled()
    expect(dom.window.document.body.innerHTML).not.toContain(HOST_ONEWORKS_SYRIAN_HAMSTER_AVATAR_ASSET_REF)
    expect(dom.window.document.body.innerHTML).not.toContain(unknownRevision)
    await act(async () => root.unmount())
    dom.window.close()
  })
})
