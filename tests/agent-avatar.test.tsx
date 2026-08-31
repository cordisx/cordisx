import { cloneAgentAvatarRef, createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

const avatarRenderSpy = vi.hoisted(() => vi.fn())
vi.mock('@oneworks/avatar-react/style.css', () => ({
  default: '.oneworks-avatar,.oneworks-avatar-editor{box-sizing:border-box}.oneworks-avatar *,.oneworks-avatar-editor *{box-sizing:border-box}.oneworks-avatar{position:relative;display:block;width:100%;height:100%}.oneworks-avatar[data-frame=rounded]{border-radius:12.5%}.oneworks-avatar[data-frame=circle]{border-radius:50%}.oneworks-avatar>.interactive-avatar{width:100%;height:100%}',
}))
vi.mock('@oneworks/avatar-react', () => ({
  Avatar: ({ className, theme, interactive, autoplay, onError }: {
    className?: string
    theme?: string
    interactive?: boolean
    autoplay?: boolean
    onError?: (error: Error) => void
  }) => {
    avatarRenderSpy({ theme, interactive, autoplay })
    return <button
    type="button"
    tabIndex={-1}
    className={`oneworks-avatar ${className ?? ''}`}
    data-renderer-theme={theme}
    data-renderer-interactive={String(interactive)}
    data-renderer-autoplay={String(autoplay)}
    onClick={() => onError?.(new Error('renderer failed'))}
    />
  },
}))

import {
  HOST_ONEWORKS_ANIMAL_AVATAR_REVISION,
  HOST_ONEWORKS_ARCTIC_FOX_AVATAR_REF,
  HOST_ONEWORKS_RED_FOX_AVATAR_REF,
  HostAgentAvatar,
  HostAgentAvatarResolver,
} from '../packages/cli/src/renderer/host-ui/conversation/AgentAvatar.js'

const previousGlobals = new Map<string, unknown>()

function installDom(theme: 'light' | 'dark' = 'light'): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body><div id="theme" data-cordisx-app-theme="${theme}"><div id="root"></div></div></body></html>`)
  for (const [key, value] of Object.entries({
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
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
    const protocol = 'github:cordisx/cordisx-protocol#609800003f802b94945e2fa17c0d77846e1a8eda'
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

  it('resolves exact OneWorks RC.8 definition refs to unmistakable fox geometry', () => {
    const resolver = new HostAgentAvatarResolver()
    for (const [ref, paletteId] of [
      [HOST_ONEWORKS_RED_FOX_AVATAR_REF, 'red-fox'],
      [HOST_ONEWORKS_ARCTIC_FOX_AVATAR_REF, 'arctic-fox'],
    ] as const) {
      const avatar = cloneAgentAvatarRef({
        kind: 'definition', ref, schema: 'oneworks.avatar', definitionVersion: 1,
        revision: HOST_ONEWORKS_ANIMAL_AVATAR_REVISION,
      })
      const result = resolver.resolve(avatar)
      expect(result.status).toBe('resolved')
      if (result.status !== 'resolved') continue
      expect(result.avatar).toEqual(avatar)
      expect(result.definition).toMatchObject({
        schema: 'oneworks.avatar', version: 1,
        scene: {
          appearance: { paletteId },
          camera: { frame: 'circle' },
          entity: { preset: 'fox' },
          face: { mouthEnabled: true, noseEnabled: true, noseShape: 'inverted-triangle' },
        },
      })
      expect(result.definition.scene.entity.preset).not.toBe('custom')
      expect(resolver.resolve(avatar)).toBe(result)
    }
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
    const renderer = dom.window.document.querySelector<HTMLButtonElement>('.oneworks-avatar')!
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

  it('uses initials for unresolved refs and writes only the kind and fallback code to DOM', async () => {
    const dom = installDom()
    const root = createRoot(dom.window.document.getElementById('root')!)
    const avatar = cloneAgentAvatarRef({ kind: 'definition', ref: 'avatar-definitions:reviewer', schema: 'oneworks.avatar', definitionVersion: 1 })
    await act(async () => root.render(<HostAgentAvatar participant={{ id: 'reviewer', role: 'agent', name: 'Review Agent', avatar }} />))
    const wrapper = dom.window.document.querySelector<HTMLElement>('.cxa-avatar')!
    expect(wrapper.dataset).toMatchObject({ avatarState: 'fallback', avatarKind: 'definition', avatarCode: 'reference-unavailable' })
    expect(wrapper.textContent).toBe('RA')
    expect(dom.window.document.body.innerHTML).not.toContain('avatar-definitions:reviewer')
    await act(async () => root.unmount())
    dom.window.close()
  })
})
